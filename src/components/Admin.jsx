/* ==========================================================================
   Access control — the admin-only screen: who is on the team, what their role
   may do, which devices hold a live session, and the credential audit trail.
   ========================================================================== */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, dateTime } from '../api.js'
import { CAPABILITIES, ROLE_BLURB, ROLE_LABEL, initials, useAuth } from '../auth.jsx'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Card, Empty, Loading, StatCard, useToast } from './ui.jsx'

const EVENT_TONE = {
  login_success: 'ok',
  login_failed: 'low',
  login_locked: 'out',
  logout: 'neutral',
  password_changed: 'accent',
  password_change_failed: 'low',
  account_unlocked: 'accent',
  sessions_revoked: 'low',
  report_generated: 'accent',
}

const EVENT_LABEL = {
  login_success: 'Signed in',
  login_failed: 'Failed sign-in',
  login_locked: 'Account locked',
  logout: 'Signed out',
  password_changed: 'Password changed',
  password_change_failed: 'Password change refused',
  account_unlocked: 'Lockout cleared',
  sessions_revoked: 'Sessions revoked',
  report_generated: 'Report generated',
}

const relative = (at) => {
  const then = Date.parse(`${String(at).replace(' ', 'T')}Z`)
  if (Number.isNaN(then)) return String(at ?? '—')
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

export default function Admin() {
  const { user, can, refreshSession } = useAuth()
  const toast = useToast()
  const [accounts, setAccounts] = useState(null)
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const [filter, setFilter] = useState('all')

  const allowed = can('admin')

  const load = useCallback(async () => {
    if (!allowed) return
    try {
      const [a, e] = await Promise.all([api.accounts(), api.authEvents({ limit: 60 })])
      setAccounts(a.accounts)
      setEvents(e.events)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [allowed])

  useEffect(() => { load() }, [load])

  const act = async (kind, email) => {
    setBusy(email)
    try {
      if (kind === 'unlock') {
        const r = await api.unlockAccount(email)
        toast(`${r.email} can sign in again`, 'ok')
      } else {
        const r = await api.revokeSessions(email)
        toast(`${r.revoked} session${r.revoked === 1 ? '' : 's'} ended for ${r.email}`, 'ok')
      }
      await load()
    } catch (err) {
      toast(err.message, 'out')
    } finally {
      setBusy('')
    }
  }

  const summary = useMemo(() => {
    const list = accounts ?? []
    return {
      total: list.length,
      admins: list.filter((a) => a.role === 'admin').length,
      operators: list.filter((a) => a.role === 'operator').length,
      viewers: list.filter((a) => a.role === 'viewer').length,
      online: list.reduce((n, a) => n + (a.active_sessions || 0), 0),
      locked: list.filter((a) => a.locked).length,
    }
  }, [accounts])

  const shown = events.filter((e) => filter === 'all' || (EVENT_TONE[e.event] ?? 'neutral') === filter)

  if (!allowed) {
    return (
      <div className="stack">
        <div className="page-head">
          <div className="head-text">
            <LogoMark size={36} className="head-mark" />
            <div className="head-copy">
              <h1>Access control</h1>
              <p className="muted">Reserved for administrators.</p>
            </div>
          </div>
        </div>
        <Card title="Not available for your role">
          <p className="muted">
            You are signed in as <strong>{user?.email}</strong> ({ROLE_LABEL[user?.role] ?? user?.role}). Team access and the
            audit trail are restricted to the <strong>admin</strong> capability.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="stack" id="admin-screen">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Access control</h1>
            <p className="muted">
              Team roles, live sessions and every credential event — checked per request by the Worker
            </p>
          </div>
        </div>
        <div className="card-actions">
          <Button onClick={() => { load(); refreshSession() }}>↻ Refresh</Button>
        </div>
      </div>

      {error && <Card title="Access data unavailable"><p className="error-text">{error}</p></Card>}

      <section className="admin-stats">
        <StatCard label="Team accounts" value={summary.total} icon="👥" delay={0} hint={`${summary.admins} admin${summary.admins === 1 ? '' : 's'}`} />
        <StatCard label="Operators" value={summary.operators} icon="🔁" delay={1} hint="can record movements" />
        <StatCard label="Viewers" value={summary.viewers} icon="👁" delay={2} hint="read-only" />
        <StatCard label="Live sessions" value={summary.online} icon="🔐" delay={3} hint="non-expired cookies" tone={summary.online > summary.total ? 'warn' : 'default'} />
        <StatCard label="Locked out" value={summary.locked} icon="⏳" delay={4} hint={summary.locked ? 'needs an unlock' : 'all clear'} tone={summary.locked ? 'danger' : 'default'} />
      </section>

      <div className="admin-split">
        <Card title="Team & sessions" subtitle="Roles are enforced server-side; ending a session logs that device out immediately">
          {!accounts ? <Loading rows={4} label="Loading team" /> : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>Account</th><th>Role</th><th>Last sign-in</th><th className="num">Sessions</th><th>State</th><th /></tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.id} className={account.id === user?.id ? 'admin-row-self' : ''}>
                      <td>
                        <div className="admin-who">
                          <span className={`avatar avatar-${account.role}`} aria-hidden="true">{initials(account.name)}</span>
                          <span className="admin-who-copy">
                            <strong>{account.name}{account.id === user?.id && <span className="muted"> · you</span>}</strong>
                            <span className="mono muted">{account.email}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <Badge tone={account.role === 'admin' ? 'accent' : 'neutral'}>{ROLE_LABEL[account.role] ?? account.role}</Badge>
                        <div className="admin-caps muted">
                          {(CAPABILITIES[account.role] ?? []).join(' · ')}
                        </div>
                      </td>
                      <td>
                        <span title={dateTime(account.last_login_at)}>{account.last_login_at ? relative(account.last_login_at) : 'never'}</span>
                      </td>
                      <td className="num">{account.active_sessions}</td>
                      <td>
                        {account.locked
                          ? <Badge tone="out">locked {account.locked_minutes_left}m</Badge>
                          : account.failed_attempts > 0
                            ? <Badge tone="low">{account.failed_attempts} failed</Badge>
                            : <Badge tone="ok">active</Badge>}
                      </td>
                      <td className="admin-actions">
                        {account.locked && (
                          <Button size="sm" disabled={busy === account.email} onClick={() => act('unlock', account.email)}>Unlock</Button>
                        )}
                        <Button
                          size="sm" variant="danger-ghost"
                          disabled={busy === account.email || account.id === user?.id || account.active_sessions === 0}
                          onClick={() => act('revoke', account.email)}
                        >
                          End sessions
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="admin-roles">
            {Object.entries(ROLE_BLURB).map(([role, blurb]) => (
              <div key={role} className="admin-role-card">
                <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>{ROLE_LABEL[role]}</Badge>
                <span className="muted">{blurb}</span>
                <span className="mono muted">{(CAPABILITIES[role] ?? []).join(' + ')}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Audit trail"
          subtitle="Every sign-in, lockout, password change and revocation"
          className="admin-events-card"
        >
          <div className="segmented admin-filter">
            {[['all', 'All'], ['ok', 'Success'], ['low', 'Warnings'], ['out', 'Lockouts']].map(([id, label]) => (
              <button key={id} type="button" className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
          {!shown.length ? <Empty title="No events yet" hint="Credential activity will appear here as the team signs in." /> : (
            <ul className="event-list">
              {shown.map((event) => (
                <li key={event.id} className="event-row">
                  <span className={`event-dot event-${EVENT_TONE[event.event] ?? 'neutral'}`} aria-hidden="true" />
                  <div className="event-copy">
                    <strong>{EVENT_LABEL[event.event] ?? event.event}</strong>
                    <span className="mono muted">{event.email}</span>
                    {event.detail && <span className="muted">{event.detail}</span>}
                  </div>
                  <div className="event-meta">
                    <span title={dateTime(event.at)}>{relative(event.at)}</span>
                    <span className="mono muted">{event.ip}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
