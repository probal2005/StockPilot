import { createHash } from 'node:crypto';
import { db } from '../db/database.js';

export function requireAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);

  if (!match) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const tokenHash = createHash('sha256').update(match[1]).digest('hex');

  try {
    const session = db.prepare(`
      SELECT
        sessions.id AS session_id,
        users.id,
        users.name,
        users.email,
        users.role
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > datetime('now')
        AND users.is_active = 1
      LIMIT 1
    `).get(tokenHash);

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    db.prepare(`
      UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?
    `).run(session.session_id);

    req.auth = {
      sessionId: session.session_id,
      user: {
        id: session.id,
        name: session.name,
        email: session.email,
        role: session.role,
      },
    };

    return next();
  } catch (error) {
    return next(error);
  }
}
