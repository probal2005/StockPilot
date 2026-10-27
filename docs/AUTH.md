# Authentication & access control

StockPilot ships with its own session system — no identity provider, no extra
dependency. Everything runs on WebCrypto and D1 inside the Worker.

## The three roles

| Role | Capabilities | What it means in the UI |
| --- | --- | --- |
| **Admin** | `read · move · manage · admin` | Everything, plus **Access control**: the team list, session revocation, lockout clearing and the credential audit trail |
| **Operator** | `read · move` | Records stock in/out, adjustments, bulk moves, reversals and product edits — no catalogue creation or deletion, no team screen |
| **Viewer** | `read` | Dashboards, products, movements, alerts and reports; create/edit controls are hidden and restock is disabled |

Capabilities are enforced **per route in the Worker** (`worker/index.js`). The nav
and screens only mirror the same list so a role never fills in a form that would
come back `403`. A forced write from a viewer is still refused:

```bash
curl -X POST https://<host>/api/products -H 'cookie: sp_session=<viewer>' ...
# 403 {"error":"Your role (viewer) cannot perform this action",
#      "details":{"required":"manage","role":"viewer"}}
```

## Passwords

- PBKDF2-SHA256, 120 000 iterations, 16-byte random salt, stored as
  `pbkdf2-sha256$120000$<salt>$<hash>` — the plaintext is never stored anywhere.
- Policy: at least 10 characters mixing three of lower case, upper case, digits
  and symbols. The account panel shows a live strength meter using the same rules.
- Verification is a length-checked, branch-free comparison.
- Unknown accounts still pay the hashing cost, so response time does not reveal
  whether an email exists, and every failure returns the same generic message.

## Sessions

- 32 random bytes, base64url, sent in an **HttpOnly, SameSite=Lax** cookie named
  `sp_session` (`Secure` when the request is HTTPS). Only the SHA-256 hash of the
  token is stored, so a database dump cannot be replayed.
- 8 hours by default, 30 days with *Keep me signed in*.
- Sliding expiry: a session past its halfway mark is extended on use, and
  `last_seen_at` is written at most every 5 minutes to keep reads read-mostly.
- Changing your password revokes every other session of that account and keeps
  the one you are using.
- Admins can end every session of any other account (**End sessions**), which
  takes effect on the next request.
- `401` from any endpoint drops the SPA back to the login screen with a notice.

## Lockout and the audit trail

- 5 failed attempts lock the account for 15 minutes; the API answers `429` with
  `details.retry_after` and a `Retry-After` header, and even the correct password
  is refused while the lock stands. The login screen counts the lock down live.
- An admin can clear a lock in one click (**Unlock**).
- Every credential event is written to `auth_events`: `login_success`,
  `login_failed`, `login_locked`, `logout`, `password_changed`,
  `password_change_failed`, `account_unlocked`, `sessions_revoked` — with the IP
  and user agent. The audit panel filters it by outcome.
- Cookie-authenticated writes are refused when the `Origin` header does not match
  the host, so a third-party page cannot drive the API with a visitor's session.

## Seeded accounts

`worker/schema.js` seeds the team once, independently of the catalogue, and only
stores the hashes. Passwords live in `worker/auth.js` (`DEMO_ACCOUNTS`).

| Email | Password | Role |
| --- | --- | --- |
| `admin@stockpilot.app` | `Pilot#2026` | Admin |
| `operator@stockpilot.app` | `Stock#2026` | Operator |
| `viewer@stockpilot.app` | `Read#2026` | Viewer |

The login screen prints these below the form, with click-to-fill and per-row
reveal. They come from `GET /api/auth/demo`, which re-verifies each seeded
password against its hash first, so an account whose password an admin rotated
simply drops off the list — the readout can never advertise a stale password.

Turn the readout off for a real deployment:

```toml
# wrangler.toml
[vars]
DEMO_CREDENTIALS = "off"
```

`GET /api/auth/demo` then returns `{ "enabled": false, "accounts": [] }` and the
panel says credential display is switched off.

## Endpoints

| Method | Path | Capability | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | public | `{ email, password, remember? }` → user, `expires_in`, session cookie |
| `GET` | `/api/auth/demo` | public | Seeded credentials whose password is still the seeded one |
| `GET` | `/api/auth/session` | public | `{ authenticated, user, active_sessions }` — the SPA's bootstrap call |
| `POST` | `/api/auth/logout` | public | Revokes the token and clears the cookie |
| `POST` | `/api/auth/password` | read | `{ current_password, new_password }`, signs other devices out |
| `GET` | `/api/auth/accounts` | admin | Team, roles, live session counts, lock state |
| `GET` | `/api/auth/events?limit=` | admin | Credential audit trail, newest first |
| `POST` | `/api/auth/unlock` | admin | `{ email }` clears a lockout |
| `POST` | `/api/auth/revoke` | admin | `{ email }` ends that account's sessions |

Every other `/api/*` route requires a session and the capability listed in
`ROUTES` (`worker/index.js`); `/api/health` stays public for uptime checks.

## Data model

```sql
admin_users   (id, email UNIQUE NOCASE, name, role CHECK(admin|operator|viewer),
               password_hash, is_active, failed_attempts, locked_until,
               last_login_at, created_at, updated_at)
auth_sessions (id, token_hash UNIQUE, user_id → admin_users, created_at,
               expires_at, last_seen_at, revoked_at, ip, user_agent)
auth_events   (id, at, email, event, detail, ip, user_agent)
```

## What is verified

`npm run verify:api` exercises the whole system against the live Worker: 319 checks covering anonymous `401`s, generic failure messages that do not leak
whether an email exists, attempt counters, the five-strike lockout with
`Retry-After`, admin unlock, role gating for viewer/operator/admin, cross-origin
write refusal, password rotation (old password rejected, other device signed out,
the in-use session preserved, the rotated account dropping out of the demo
readout) and session revocation. The UI suite signs in through the real login
form — wrong password first, then click-to-fill from the credentials panel — and
319 checks the admin screens, role-gated nav, read-only viewer layout and the
account panel, then forces a viewer write to prove the Worker refuses it.

Not verified automatically: anything visual. The login screen's aurora, glass
blur and shake animation are CSS only, and jsdom has no CSS engine — those need
the browser preview.
