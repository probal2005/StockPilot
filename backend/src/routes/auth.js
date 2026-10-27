import { Router } from 'express';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { db } from '../db/database.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { requireAuth } from '../middleware/require-auth.js';

const router = Router();
const SESSION_HOURS = 8;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeSecretEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

// One-time first-admin setup. Disabled unless a setup secret is configured.
router.post('/setup', async (req, res, next) => {
  try {
    const expectedSecret = process.env.INITIAL_ADMIN_SETUP_SECRET;

    if (!expectedSecret || expectedSecret.length < 32) {
      return res.status(404).json({ error: 'Setup is unavailable.' });
    }

    if (!safeSecretEqual(req.get('x-setup-secret'), expectedSecret)) {
      return res.status(403).json({ error: 'Setup authorization failed.' });
    }

    const { name, email, password } = req.body ?? {};

    if (
      typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100 ||
      typeof email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      typeof password !== 'string' || password.length < 12 || password.length > 128
    ) {
      return res.status(400).json({
        error: 'Provide a valid name, email, and password of 12–128 characters.',
      });
    }

    const passwordHash = await hashPassword(password);

    const user = db.transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) {
        const error = new Error('Initial administrator has already been created.');
        error.status = 409;
        throw error;
      }

      const result = db.prepare(`
        INSERT INTO users (name, email, password_hash, role)
        VALUES (?, ?, ?, 'admin')
      `).run(name.trim(), email.trim().toLowerCase(), passwordHash);

      return db.prepare(`
        SELECT id, name, email, role FROM users WHERE id = ?
      `).get(result.lastInsertRowid);
    })();

    return res.status(201).json({
      message: 'Initial administrator created. You can now log in.',
      user: publicUser(user),
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });

    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    return next(error);
  }
});

// Login: returns the session token once; only its SHA-256 hash is stored.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    if (
      typeof email !== 'string' || email.length > 254 ||
      typeof password !== 'string' || password.length > 128
    ) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = db.prepare(`
      SELECT id, name, email, password_hash, role, is_active
      FROM users
      WHERE email = ? COLLATE NOCASE
      LIMIT 1
    `).get(email.trim());

    if (
      !user ||
      user.is_active !== 1 ||
      !(await verifyPassword(password, user.password_hash))
    ) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');

    db.prepare(`
      INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      user.id,
      hashToken(token),
      expiresAt,
      String(req.get('user-agent') || '').slice(0, 500) || null,
      req.ip || null,
    );

    return res.status(200).json({
      message: 'Login successful.',
      token,
      tokenType: 'Bearer',
      expiresAt: `${expiresAt} UTC`,
      user: publicUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.status(200).json({ user: req.auth.user });
});

router.post('/logout', requireAuth, (req, res, next) => {
  try {
    db.prepare(`
      UPDATE sessions SET revoked_at = datetime('now')
      WHERE id = ? AND revoked_at IS NULL
    `).run(req.auth.sessionId);

    return res.status(200).json({ message: 'Logout successful.' });
  } catch (error) {
    return next(error);
  }
});

export default router;
