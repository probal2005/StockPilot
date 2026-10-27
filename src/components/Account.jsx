/* ==========================================================================
   The signed-in user's own panel: identity, live session count, password
   rotation (which signs every other device out) and sign out.
   ========================================================================== */
import { useState } from 'react'
import { ROLE_BLURB, ROLE_LABEL, initials, useAuth } from '../auth.jsx'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Field, Modal, useToast } from './ui.jsx'

/** Client mirror of the Worker's policy, so the meter warns before the 400. */
export function passwordChecks(password = '') {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password))
  return {
    length: password.length >= 10,
    classes: classes.length >= 3,
    long: password.length >= 14,
    classesCount: classes.length,
  }
}

export function PasswordMeter({ value }) {
  const checks = passwordChecks(value)
  // 1 bar as soon as anything is typed, one more per rule satisfied.
  const score = value ? Math.min(4, 1 + (checks.length ? 1 : 0) + (checks.classes ? 1 : 0) + (checks.long ? 1 : 0)) : 0
  const label = !value ? 'Enter a password' : !checks.length ? 'Too short — 10 characters minimum'
    : !checks.classes ? 'Mix upper case, lower case, digits or symbols'
    : checks.long ? 'Strong' : 'Acceptable'
  return (
    <div className="pw-meter" data-score={score} aria-live="polite">
      <div className="pw-bars">{Array.from({ length: 4 }, (_, i) => <i key={i} className={i < score ? 'on' : ''} />)}</div>
      <span className="field-hint">{label}</span>
    </div>
  )
}

export default function AccountModal({ onClose }) {
  const { user, activeSessions, changePassword, logout } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (event) => {
    event.preventDefault()
    setError(null)
    if (form.next !== form.confirm) { setError('New passwords do not match'); return }
    const checks = passwordChecks(form.next)
    if (!checks.length || !checks.classes) { setError('Password must be 10+ characters mixing at least three character types'); return }
    setBusy(true)
    try {
      await changePassword(form.current, form.next)
      setForm({ current: '', next: '', confirm: '' })
      toast('Password updated — other devices were signed out', 'ok')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={<span className="modal-title"><LogoMark size={26} className="modal-mark" />Account</span>}
      subtitle="Your identity, session and password"
      onClose={onClose}
      width={540}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        <Button variant="danger-ghost" onClick={async () => { await logout(); onClose() }}>Sign out</Button>
      </>}
    >
      <div className="account-id">
        <span className={`avatar avatar-${user?.role}`} aria-hidden="true">{initials(user?.name)}</span>
        <div className="account-id-copy">
          <strong>{user?.name}</strong>
          <span className="mono muted">{user?.email}</span>
          <span className="account-meta">
            <Badge tone={user?.role === 'admin' ? 'accent' : 'neutral'}>{ROLE_LABEL[user?.role] ?? user?.role}</Badge>
            <span className="muted">{ROLE_BLURB[user?.role]}</span>
          </span>
        </div>
      </div>

      <dl className="account-facts">
        <div><dt>Live sessions</dt><dd>{activeSessions} device{activeSessions === 1 ? '' : 's'}</dd></div>
        <div><dt>Last sign-in</dt><dd>{user?.last_login_at ? String(user.last_login_at).replace('T', ' ').slice(0, 16) : 'this session'}</dd></div>
        <div><dt>Session storage</dt><dd className="mono">HttpOnly cookie · sp_session</dd></div>
      </dl>

      <form className="account-form" onSubmit={submit}>
        <h4>Change password</h4>
        <Field label="Current password">
          <input type="password" autoComplete="current-password" value={form.current} onChange={set('current')} required />
        </Field>
        <div className="form-grid">
          <Field label="New password" hint="10+ characters, three character types">
            <input type="password" autoComplete="new-password" value={form.next} onChange={set('next')} required />
          </Field>
          <Field label="Confirm new password" error={form.confirm && form.confirm !== form.next ? 'Does not match' : null}>
            <input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
          </Field>
        </div>
        <PasswordMeter value={form.next} />
        {error && <p className="error-text">{error}</p>}
        <div className="account-form-foot">
          <span className="muted small">Changing your password revokes every other session.</span>
          <Button variant="primary" disabled={busy || !form.current || !form.next}>{busy ? 'Updating…' : 'Update password'}</Button>
        </div>
      </form>
    </Modal>
  )
}
