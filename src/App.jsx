import { useCallback, useEffect, useState } from 'react'
import { api, nf } from './api.js'
import { AuthProvider, ROLE_LABEL, initials, useAuth } from './auth.jsx'
import { ToastProvider } from './components/ui.jsx'
import Dashboard from './components/Dashboard.jsx'
import Products from './components/Products.jsx'
import Stock from './components/Stock.jsx'
import Alerts from './components/Alerts.jsx'
import Purchasing from './components/Purchasing.jsx'
import Suppliers from './components/Suppliers.jsx'
import Counts from './components/Counts.jsx'
import Reports from './components/Reports.jsx'
import Admin from './components/Admin.jsx'
import Login from './components/Login.jsx'
import AccountModal from './components/Account.jsx'
import { Logo, CyberWatermark, GhostMark, BrandCredit, BrandFooter } from './brand.jsx'

/* Every entry declares the capability it needs; the nav only offers what the
   signed-in role may actually use, and the Worker re-checks every request. */
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊', capability: 'read' },
  { id: 'products', label: 'Products', icon: '📦', capability: 'read' },
  { id: 'stock', label: 'Stock movements', icon: '🔁', capability: 'read' },
  { id: 'alerts', label: 'Low-stock alerts', icon: '⚠️', capability: 'read' },
  { id: 'purchasing', label: 'Purchasing', icon: '🛒', capability: 'read' },
  { id: 'suppliers', label: 'Suppliers', icon: '🏭', capability: 'read' },
  { id: 'counts', label: 'Stock counts', icon: '🧾', capability: 'read' },
  { id: 'reports', label: 'Reports', icon: '📈', capability: 'read' },
  { id: 'access', label: 'Access control', icon: '🛡', capability: 'admin' },
]

const routeFromHash = (nav) => {
  const id = window.location.hash.replace(/^#\/?/, '')
  return nav.some((n) => n.id === id) ? id : 'dashboard'
}

const THEME_KEY = 'stockpilot:theme'

function initialTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* storage blocked */ }
  return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark'
}

/* The theme lives above the session gate so the login screen is themed too. */
function useTheme() {
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { window.localStorage.setItem(THEME_KEY, theme) } catch { /* storage blocked */ }
  }, [theme])
  return [theme, useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])]
}

function BootSplash() {
  return (
    <div className="boot" id="boot-splash">
      <CyberWatermark />
      <Logo size={52} tagline="ADMIN CONSOLE" />
      <p className="muted">Restoring your session…</p>
      <span className="boot-bar" aria-hidden="true"><i /></span>
    </div>
  )
}

function Shell({ theme, toggleTheme }) {
  const { user, logout, can, notice, dismissNotice } = useAuth()
  const [route, setRoute] = useState(() => routeFromHash(NAV))
  const [refreshKey, setRefreshKey] = useState(0)
  const [alertCount, setAlertCount] = useState(0)
  const [status, setStatus] = useState({ state: 'connecting', label: 'Connecting…' })
  const [accountOpen, setAccountOpen] = useState(false)

  const nav = NAV.filter((item) => can(item.capability))

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash(NAV))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((id) => {
    window.location.hash = `#/${id}`
    setRoute(id)
  }, [])

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  useEffect(() => {
    let alive = true
    setStatus({ state: 'connecting', label: 'Connecting…' })
    api.alerts()
      .then((r) => {
        if (!alive) return
        setAlertCount(r.summary.total)
        setStatus({ state: 'online', label: `Live data · ${nf.format(r.summary.total)} alert${r.summary.total === 1 ? '' : 's'}` })
      })
      .catch((e) => {
        if (!alive) return
        setStatus({ state: 'offline', label: e.message })
      })
    return () => { alive = false }
  }, [refreshKey])

  const Screen = {
    dashboard: Dashboard, products: Products, stock: Stock, alerts: Alerts,
    purchasing: Purchasing, suppliers: Suppliers, counts: Counts,
    reports: Reports, access: Admin,
  }[route] ?? Dashboard
  const activeRoute = nav.some((n) => n.id === route) ? route : 'dashboard'

  return (
    <div className="app">
      <CyberWatermark />
      <aside className="sidebar">
        <GhostMark size={300} className="sidebar-ghost" />
        <div className="brand">
          <Logo size={40} />
        </div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id} type="button"
              className={`nav-item ${activeRoute === item.id ? 'active' : ''}`}
              onClick={() => navigate(item.id)}
              aria-current={activeRoute === item.id ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'alerts' && alertCount > 0 && <span className="nav-badge">{nf.format(alertCount)}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="session-card" onClick={() => setAccountOpen(true)}>
            <span className={`avatar avatar-${user.role}`} aria-hidden="true">{initials(user.name)}</span>
            <span className="session-copy">
              <strong>{user.name}</strong>
              <span className="mono muted">{user.email}</span>
            </span>
            <span className="session-role">{ROLE_LABEL[user.role] ?? user.role}</span>
          </button>
          <div className="row-actions">
            <button type="button" className="btn btn-default btn-sm" onClick={() => setAccountOpen(true)}>⚙ Account</button>
            <button type="button" className="btn btn-default btn-sm" onClick={logout}>⏏ Sign out</button>
          </div>
          <button type="button" className="theme-toggle" data-theme={theme} onClick={toggleTheme} aria-pressed={theme === 'light'}>
            <span className="toggle-track"><span className="toggle-knob" aria-hidden="true">{theme === 'dark' ? '🌙' : '☀'}</span></span>
            <span>{theme === 'dark' ? 'Dark theme' : 'Light theme'}</span>
          </button>
          <div className={`status status-${status.state}`}>
            <i className="dot" /> <span>{status.label}</span>
          </div>
          <button type="button" className="btn btn-default btn-sm btn-block" onClick={refresh}>↻ Refresh data</button>
          <BrandCredit />
        </div>
      </aside>

      <main className="content">
        {notice && (
          <div className="app-notice" role="status">
            <span aria-hidden="true">◆</span>
            <span>{notice}</span>
            <button type="button" className="link-btn" onClick={dismissNotice}>Dismiss</button>
          </div>
        )}
        <div className="screen" key={activeRoute}>
          <Screen onNavigate={navigate} refreshKey={refreshKey} onChanged={refresh} />
        </div>
        <BrandFooter />
      </main>

      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
    </div>
  )
}

function Gate({ theme, toggleTheme }) {
  const { loading, authenticated } = useAuth()
  if (loading) return <BootSplash />
  if (!authenticated) return <Login />
  return <Shell theme={theme} toggleTheme={toggleTheme} />
}

export default function App() {
  // The theme sits above the session gate, so the login screen is themed too.
  const [theme, toggleTheme] = useTheme()
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate theme={theme} toggleTheme={toggleTheme} />
      </AuthProvider>
    </ToastProvider>
  )
}
