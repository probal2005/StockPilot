/* ==========================================================================
   Admin authentication: PBKDF2 password hashing, hashed session tokens in
   HttpOnly cookies, role-based capabilities, per-account lockout and an audit
   trail of every credential event.

   Everything here runs on WebCrypto (available in Workers) so no dependency
   and no secret pepper is needed beyond the D1 database itself.
   ========================================================================== */

import { HttpError, badRequest, fail, json, requireString } from './lib.js'

const SCHEME = 'pbkdf2-sha256'
const ITERATIONS = 120000 // ~40-60 ms per verification in workerd
const SALT_BYTES = 16
const TOKEN_BYTES = 32
const SESSION_HOURS = 8
const REMEMBER_DAYS = 30
const MAX_ATTEMPTS = 5
const LOCK_MINUTES = 15
export const COOKIE = 'sp_session'

const encoder = new TextEncoder()
const bytesToB64 = (bytes) => {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s)
}
const b64ToBytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
const base64url = (bytes) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const sqlNow = (date = new Date()) => date.toISOString().slice(0, 19).replace('T', ' ')
const sqlIn = (ms) => sqlNow(new Date(Date.now() + ms))

/* ------------------------------------------------------------- hashing ---- */

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES)), iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  return `${SCHEME}$${iterations}$${bytesToB64(salt)}$${bytesToB64(bits)}`
}

/** Length-checked, branch-free comparison of two derived hashes. */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored || '').split('$')
  if (scheme !== SCHEME || !iterations || !salt || !hash) return false
  const derived = await hashPassword(password, b64ToBytes(salt), Number(iterations))
  return constantTimeEqual(derived, stored)
}

export async function sha256(value) {
  return bytesToB64(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

/* ------------------------------------------------------- password policy -- */

export function assertPasswordStrength(password) {
  const value = requireString(password, 'password', { max: 200 })
  if (value.length < 10) throw badRequest('Password must be at least 10 characters')
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length
  if (classes < 3) throw badRequest('Password must mix upper case, lower case, digits and symbols (at least three)')
  return value
}

/* -------------------------------------------------------------- sessions -- */

const clientMeta = (request) => ({
  ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local',
  ua: (request.headers.get('user-agent') || 'unknown').slice(0, 160),
})

export async function createSession(env, request, user, { remember = false } = {}) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
  const ttl = remember ? REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000
  const { ip, ua } = clientMeta(request)
  await env.DB.prepare(
    `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(await sha256(token), user.id, sqlNow(), sqlIn(ttl), sqlNow(), ip, ua).run()
  return { token, maxAge: Math.floor(ttl / 1000) }
}

export function cookieHeader(token, maxAge, { secure = false, clear = false } = {}) {
  const parts = [`${COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${clear ? 0 : maxAge}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export const isSecureRequest = (url) => url.protocol === 'https:'

/**
 * Resolve the signed-in user from the session cookie. Returns null when there
 * is no cookie, the token is unknown, revoked, expired or the account is off.
 * Sliding expiry: a session past its halfway mark is extended on use, and
 * last_seen_at is only written every few minutes to keep reads read-mostly.
 */
export async function currentUser(env, request) {
  const raw = cookieValue(request.headers.get('cookie'), COOKIE)
  if (!raw) return null
  const { results } = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.created_at, s.last_seen_at,
            u.id, u.email, u.name, u.role, u.is_active, u.last_login_at
     FROM auth_sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')
     LIMIT 1`,
  ).bind(await sha256(raw)).all()
  const row = results?.[0]
  if (!row || !row.is_active) return null

  const total = Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) - Date.parse(`${row.created_at.replace(' ', 'T')}Z`)
  const halfway = Date.parse(`${row.created_at.replace(' ', 'T')}Z`) + total / 2
  const stale = Date.now() - Date.parse(`${row.last_seen_at.replace(' ', 'T')}Z`) > 5 * 60000
  if (stale || Date.now() > halfway) {
    await env.DB.prepare(
      `UPDATE auth_sessions SET last_seen_at = ?${Date.now() > halfway ? ', expires_at = ?' : ''}
       WHERE id = ?`,
    ).bind(...(Date.now() > halfway ? [sqlNow(), sqlIn(SESSION_HOURS * 3600000), row.session_id] : [sqlNow(), row.session_id])).run()
  }
  return {
    id: row.id, email: row.email, name: row.name, role: row.role,
    last_login_at: row.last_login_at, session_expires_at: row.expires_at,
  }
}

export function cookieValue(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/* ------------------------------------------------------------ audit trail -- */

export async function recordEvent(env, request, email, event, detail = '') {
  const { ip, ua } = clientMeta(request)
  try {
    await env.DB.prepare(
      `INSERT INTO auth_events (email, event, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
    ).bind(email, event, detail, ip, ua).run()
  } catch {
    /* auditing must never break a request */
  }
}

/* ------------------------------------------------------------ capabilities */

export const ROLE_CAPABILITIES = {
  admin: ['read', 'move', 'manage', 'admin'],
  operator: ['read', 'move'],
  viewer: ['read'],
}

export const can = (user, capability) => Boolean(user && (ROLE_CAPABILITIES[user.role] ?? []).includes(capability))

/* ---------------------------------------------------------------- handlers */

/**
 * Seeded team accounts. Passwords live here (source), never in the database —
 * the database only ever holds PBKDF2 hashes produced at seed time.
 */
export const DEMO_ACCOUNTS = [
  { email: 'admin@stockpilot.app', password: 'Pilot#2026', name: 'Avery Stone', role: 'admin' },
  { email: 'operator@stockpilot.app', password: 'Stock#2026', name: 'Jordan Reyes', role: 'operator' },
  { email: 'viewer@stockpilot.app', password: 'Read#2026', name: 'Sam Whitfield', role: 'viewer' },
]

/**
 * Demo affordance: the seeded accounts whose password is still the seeded one,
 * so the login screen can show them. Turn it off with `DEMO_CREDENTIALS = "off"`
 * in wrangler.toml (the endpoint then returns an empty list).
 */
export async function demoAccounts(env) {
  if (String(env.DEMO_CREDENTIALS ?? 'on').toLowerCase() === 'off') {
    return json({ enabled: false, accounts: [] })
  }
  const accounts = []
  for (const seed of DEMO_ACCOUNTS) {
    const { results } = await env.DB.prepare(`SELECT password_hash FROM admin_users WHERE email = ? COLLATE NOCASE`).bind(seed.email).all()
    const hash = results?.[0]?.password_hash
    // Only advertise a password that still works — if an admin rotated it we
    // stop printing the stale one.
    if (hash && (await verifyPassword(seed.password, hash))) {
      accounts.push({ email: seed.email, password: seed.password, name: seed.name, role: seed.role })
    }
  }
  return json({ enabled: true, accounts })
}

/** Block cross-site cookie-authenticated writes (browsers always send Origin). */
export function assertSameOrigin(request) {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const origin = request.headers.get('origin')
  if (!origin) return
  const host = request.headers.get('host')
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    throw fail(403, 'Invalid Origin header')
  }
  if (parsed.host !== host) throw fail(403, 'Cross-origin requests are not allowed')
}

/** Admin only: revoke every session of an account (e.g. a lost laptop). */
export async function revokeSessions(env, request, user) {
  const body = await request.json().catch(() => ({}))
  const email = requireString(body.email, 'email', { max: 200 }).toLowerCase()
  const { results } = await env.DB.prepare(`SELECT id FROM admin_users WHERE email = ? COLLATE NOCASE`).bind(email).all()
  const id = results?.[0]?.id
  if (!id) throw fail(404, 'No such account')
  if (id === user.id) throw badRequest('Use sign out to end your own session')
  const revoked = await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(sqlNow(), id).run()
  await recordEvent(env, request, user.email, 'sessions_revoked', `${email} (${revoked.meta?.changes ?? 0})`)
  return json({ ok: true, email, revoked: revoked.meta?.changes ?? 0 })
}

export async function login(env, request, url) {
  const body = await request.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const remember = Boolean(body.remember)
  if (!email || !password) throw badRequest('Email and password are required')

  const { results } = await env.DB.prepare(
    `SELECT id, email, name, role, password_hash, is_active, failed_attempts, locked_until, last_login_at
     FROM admin_users WHERE email = ? COLLATE NOCASE LIMIT 1`,
  ).bind(email).all()
  const user = results?.[0]
  const genericFailure = fail(401, 'Email or password is incorrect')

  if (user?.locked_until && Date.parse(`${user.locked_until.replace(' ', 'T')}Z`) > Date.now()) {
    const retry = Math.ceil((Date.parse(`${user.locked_until.replace(' ', 'T')}Z`) - Date.now()) / 1000)
    await recordEvent(env, request, email, 'login_locked', `retry_in=${retry}s`)
    throw new HttpErrorLocked(retry)
  }

  const ok = user ? await verifyPassword(password, user.password_hash) : false
  if (!ok || !user || !user.is_active) {
    if (user) {
      const attempts = (user.failed_attempts || 0) + 1
      const lock = attempts >= MAX_ATTEMPTS
      await env.DB.prepare(
        `UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?`,
      ).bind(lock ? 0 : attempts, lock ? sqlIn(LOCK_MINUTES * 60000) : null, user.id).run()
      await recordEvent(env, request, email, lock ? 'login_locked' : 'login_failed', lock ? `locked for ${LOCK_MINUTES}m` : `attempt ${attempts}/${MAX_ATTEMPTS}`)
      if (lock) throw new HttpErrorLocked(LOCK_MINUTES * 60)
      throw fail(401, 'Email or password is incorrect', { attempts_left: MAX_ATTEMPTS - attempts })
    }
    await recordEvent(env, request, email, 'login_failed', 'unknown account')
    throw genericFailure
  }

  const session = await createSession(env, request, user, { remember })
  await env.DB.prepare(`UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`)
    .bind(sqlNow(), user.id).run()
  await recordEvent(env, request, email, 'login_success', `role=${user.role}${remember ? ' remember=1' : ''}`)

  return json(
    { user: { id: user.id, email: user.email, name: user.name, role: user.role, last_login_at: user.last_login_at }, expires_in: session.maxAge },
    200,
    { 'set-cookie': cookieHeader(session.token, session.maxAge, { secure: isSecureRequest(url) }) },
  )
}

class HttpErrorLocked extends HttpError {
  constructor(retryAfter) {
    super(429, `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`, { retry_after: retryAfter })
    this.headers = { 'retry-after': String(retryAfter) }
  }
}

export async function logout(env, request, user, url) {
  const raw = cookieValue(request.headers.get('cookie'), COOKIE)
  if (raw) {
    await env.DB.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?`).bind(sqlNow(), await sha256(raw)).run()
  }
  if (user) await recordEvent(env, request, user.email, 'logout', '')
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0, { secure: isSecureRequest(url), clear: true }) })
}

/** Change your own password: verifies the old one and kicks other sessions. */
export async function changePassword(env, request, user, url) {
  const body = await request.json().catch(() => ({}))
  const current = requireString(body.current_password, 'current_password', { max: 200 })
  const next = assertPasswordStrength(body.new_password)
  const { results } = await env.DB.prepare(`SELECT password_hash FROM admin_users WHERE id = ?`).bind(user.id).all()
  if (!(await verifyPassword(current, results?.[0]?.password_hash))) {
    await recordEvent(env, request, user.email, 'password_change_failed', 'wrong current password')
    throw fail(401, 'Current password is incorrect')
  }
  const hash = await hashPassword(next)
  await env.DB.prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`).bind(hash, sqlNow(), user.id).run()
  // every other device is signed out; this one keeps its session
  const raw = cookieValue(request.headers.get('cookie'), COOKIE)
  await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
  ).bind(sqlNow(), user.id, raw ? await sha256(raw) : '').run()
  await recordEvent(env, request, user.email, 'password_changed', 'other sessions revoked')
  return json({ ok: true })
}

/** Admin view of the team: roles, last sign-in, lock state, live sessions. */
export async function listAccounts(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.is_active, u.last_login_at, u.locked_until, u.failed_attempts, u.created_at,
            (SELECT COUNT(*) FROM auth_sessions s
              WHERE s.user_id = u.id AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')) AS active_sessions
     FROM admin_users u ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, u.email`,
  ).all()
  const now = Date.now()
  return json({
    accounts: (results ?? []).map((a) => ({
      ...a,
      locked: Boolean(a.locked_until && Date.parse(`${a.locked_until.replace(' ', 'T')}Z`) > now),
      locked_minutes_left: a.locked_until ? Math.max(0, Math.ceil((Date.parse(`${a.locked_until.replace(' ', 'T')}Z`) - now) / 60000)) : 0,
    })),
  })
}

/** Clear a lockout (admin only) so a colleague can sign back in. */
export async function unlockAccount(env, request, user) {
  const body = await request.json().catch(() => ({}))
  const email = requireString(body.email, 'email', { max: 200 }).toLowerCase()
  const target = await env.DB.prepare(`SELECT id FROM admin_users WHERE email = ? COLLATE NOCASE`).bind(email).all()
  const id = target.results?.[0]?.id
  if (!id) throw fail(404, 'No such account')
  await env.DB.prepare(`UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?`).bind(id).run()
  await recordEvent(env, request, user.email, 'account_unlocked', email)
  return json({ ok: true, email })
}

/** Recent credential events (admin only). */
export async function listEvents(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 200)
  const { results } = await env.DB.prepare(
    `SELECT id, at, email, event, detail, ip, user_agent FROM auth_events ORDER BY id DESC LIMIT ?`,
  ).bind(limit).all()
  return json({ events: results ?? [] })
}

/** The session's own detail — used by the SPA's account panel. */
export async function sessionInfo(env, request, user) {
  if (!user) return json({ authenticated: false, user: null })
  const { results } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`,
  ).bind(user.id).all()
  return json({ authenticated: true, user, active_sessions: results?.[0]?.n ?? 1 })
}
