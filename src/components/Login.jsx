/* ==========================================================================
   The sign-in screen. Same aurora glass language as the app shell, plus the
   seeded team credentials printed below the form (from /api/auth/demo, which
   only returns accounts whose password is still the seeded one).
   ========================================================================== */
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth.jsx'
import { CyberWatermark, Logo, LogoMark } from '../brand.jsx'
import { Badge } from './ui.jsx'
import { api } from '../api.js'

const mmss = (seconds) => {
  const s = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default function Login() {
  const { login, notice, dismissNotice, loading } = useAuth()
  const [demoAccounts, setDemoAccounts] = useState([])
  const [demoLoading, setDemoLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [attemptsLeft, setAttemptsLeft] = useState(null)
  const [lockFor, setLockFor] = useState(0)
  const [shake, setShake] = useState(0)
  const passwordRef = useRef(null)

  /* Lockout countdown: the Worker sends retry_after, we tick it down locally. */
  useEffect(() => {
    if (lockFor <= 0) return
    const id = setInterval(() => setLockFor((s) => (s <= 1 ? 0 : s - 1)), 1000)
    return () => clearInterval(id)
  }, [lockFor])

  const locked = lockFor > 0

  // Load only demo accounts explicitly exposed by the local Worker.
  useEffect(() => {
    let alive = true
    api.demoAccounts()
      .then((payload) => {
        if (alive) setDemoAccounts(
          payload.enabled && Array.isArray(payload.accounts) ? payload.accounts : []
        )
      })
      .catch(() => {
        if (alive) setDemoAccounts([])
      })
      .finally(() => {
        if (alive) setDemoLoading(false)
      })
    return () => { alive = false }
  }, [])

  const chooseDemo = async (role) => {
    if (busy || loading || locked) return

    const account = demoAccounts.find((item) => item.role === role)
    if (!account) {
      setError(`The ${role} demo account is unavailable. Check the local Worker demo-account configuration.`)
      return
    }

    // Populate the ordinary sign-in form, then authenticate through the same
    // API login endpoint as a manually entered email and password.
    setEmail(account.email)
    setPassword(account.password)
    setRemember(false)
    setError(null)
    setAttemptsLeft(null)
    setBusy(true)

    try {
      await login(account.email, account.password, false)
    } catch (e) {
      setError(e?.message || 'Demo sign-in failed. Check that the local Worker is running.')
      setShake((n) => n + 1)
      if (e.status === 429 && e.details?.retry_after) setLockFor(e.details.retry_after)
      else if (e.details?.attempts_left != null) setAttemptsLeft(e.details.attempts_left)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event) => {
    event?.preventDefault()
    if (busy || locked) return
    setBusy(true)
    setError(null)
    setAttemptsLeft(null)
    try {
      await login(email.trim(), password, remember)
    } catch (e) {
      setError(e.message)
      setShake((n) => n + 1)
      if (e.status === 429 && e.details?.retry_after) setLockFor(e.details.retry_after)
      else if (e.details?.attempts_left != null) setAttemptsLeft(e.details.attempts_left)
    } finally {
      setBusy(false)
    }
  }


  return (
    <div className="login-screen" id="login-screen">
      <CyberWatermark />
      <div className="login-aurora" aria-hidden="true" />

      <div className="login-wrap">
        <section className="login-card glass" key={shake} data-shake={shake || undefined}>
          <div className="login-card-glow" aria-hidden="true" />
          <header className="login-head">
            <Logo size={44} tagline="ADMIN CONSOLE" />
          </header>

          <div className="login-title">
            <h1>Sign in</h1>
            <p className="muted">
              Role-based access — viewers read, operators move stock, admins manage the catalogue and the team.
            </p>
          </div>

          {notice && !error && (
            <div className="login-notice" role="status">
              <span aria-hidden="true">◆</span>
              <span>{notice}</span>
              <button type="button" className="link-btn" onClick={dismissNotice}>Dismiss</button>
            </div>
          )}

          {error && (
            <div className="login-error" role="alert">
              <span className="login-error-icon" aria-hidden="true">!</span>
              <div className="login-error-copy">
                <strong>{error}</strong>
                {attemptsLeft != null && (
                  <span>{attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left before the account locks.</span>
                )}
              </div>
            </div>
          )}

          {locked && (
            <div className="login-lock" role="alert">
              <span aria-hidden="true">⏳</span>
              <span>Locked for failed attempts. Try again in</span>
              <strong className="mono">{mmss(lockFor)}</strong>
            </div>
          )}

          <form className="login-form" onSubmit={submit} noValidate>
            <label className="login-field">
              <span className="login-label">Work email</span>
              <span className="login-input">
                <span className="login-input-icon" aria-hidden="true">@</span>
                <input
                  name="email" type="email" autoComplete="username" inputMode="email"
                  placeholder="admin@stockpilot.app" value={email} disabled={locked}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </span>
            </label>

            <label className="login-field">
              <span className="login-label">Password</span>
              <span className="login-input">
                <span className="login-input-icon" aria-hidden="true">•••</span>
                <input
                  ref={passwordRef} name="password" type={reveal ? 'text' : 'password'}
                  autoComplete="current-password" placeholder="Your password"
                  value={password} disabled={locked}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button" className="login-reveal" onClick={() => setReveal((v) => !v)}
                  aria-pressed={reveal} aria-label={reveal ? 'Hide password' : 'Show password'}
                >
                  {reveal ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            <div className="login-row">
              <label className="checkbox">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>Keep me signed in for 30 days</span>
              </label>
              <span className="login-hint muted">8-hour session otherwise</span>
            </div>

            <button type="submit" className="btn btn-primary btn-block login-submit" disabled={busy || locked || !email || !password}>
              {busy ? 'Verifying…' : locked ? `Locked · ${mmss(lockFor)}` : 'Sign in to console'}
            </button>
          </form>

          <footer className="login-foot">
            <LogoMark size={18} />
            <span>PBKDF2-SHA256 · HttpOnly session cookie · lockout after 5 failed attempts</span>
          </footer>
        </section>

        <aside className="login-demo glass" aria-label="Demo login options">
          <div className="login-demo-head">
            <h4>Quick demo access</h4>
            <Badge tone="ok">demo credentials</Badge>
          </div>
          <p className="login-demo-blurb muted">
            Choose a role to fill the sign-in form and authenticate with its demo account.
          </p>
          <div className="login-form" style={{ marginTop: 16, gap: 10 }}>
            {demoLoading && <p className="muted">Loading demo credentials…</p>}
            {!demoLoading && demoAccounts.length === 0 && (
              <p className="muted" role="status">
                No demo accounts are available. Check that the local Worker is running and demo accounts are configured.
              </p>
            )}
            {[
              { role: 'admin', label: 'Admin', primary: true },
              { role: 'operator', label: 'Operator' },
              { role: 'viewer', label: 'Viewer' },
            ].map(({ role, label, primary }) => {
              const account = demoAccounts.find((item) => item.role === role)
              return (
                <div className="login-demo-account" key={role}>
                  <div className="login-demo-credentials">
                    <span><strong>{label}</strong> · {account?.email || 'Not configured'}</span>
                    {account && <span>Password: <code>{account.password}</code></span>}
                  </div>
                  <button
                    type="button"
                    className={`btn btn-block${primary ? ' btn-primary' : ''}`}
                    disabled={busy || loading || locked || demoLoading || !account}
                    onClick={() => chooseDemo(role)}
                  >
                    {busy ? 'Signing in…' : `Continue as ${label}`}
                  </button>
                </div>
              )
            })}
          </div>
          <p className="login-demo-foot muted">
            Selecting a role fills the sign-in form and signs in through the local Worker.
          </p>
        </aside>
      </div>

      <p className="login-sig muted">
        {loading ? 'Restoring session…' : 'StockPilot · Smart Inventory System'}
      </p>
    </div>
  )
}
