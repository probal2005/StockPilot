// Typed-ish fetch wrapper around the Worker API.
const BASE = '/api'

/* Anything can end the session (expiry, revocation from another device), so a
   401 is announced once and the app gate drops back to the login screen. */
const listeners = new Set()
export const onUnauthorized = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
const announceUnauthorized = () => { for (const fn of listeners) fn() }

async function request(path, { method = 'GET', body, signal, silent = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = { error: text } }
  }
  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status})`)
    err.status = res.status
    err.details = payload?.details ?? null
    // A failed sign-in attempt is not an expired session.
    if (res.status === 401 && !silent) announceUnauthorized()
    throw err
  }
  return payload
}

const qs = (params = {}) => {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue
    sp.set(key, String(value))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  /* ---- authentication ---- */
  session: () => request('/auth/session', { silent: true }),
  login: (body) => request('/auth/login', { method: 'POST', body, silent: true }),
  logout: () => request('/auth/logout', { method: 'POST', silent: true }),
  demoAccounts: () => request('/auth/demo', { silent: true }),
  changePassword: (body) => request('/auth/password', { method: 'POST', body }),
  accounts: () => request('/auth/accounts'),
  authEvents: (params) => request(`/auth/events${qs(params)}`),
  unlockAccount: (email) => request('/auth/unlock', { method: 'POST', body: { email } }),
  revokeSessions: (email) => request('/auth/revoke', { method: 'POST', body: { email } }),

  dashboard: (params) => request(`/dashboard${qs(params)}`),
  alerts: (params) => request(`/alerts${qs(params)}`),
  categories: () => request('/categories'),

  products: (params) => request(`/products${qs(params)}`),
  product: (id) => request(`/products/${id}`),
  createProduct: (body) => request('/products', { method: 'POST', body }),
  updateProduct: (id, body) => request(`/products/${id}`, { method: 'PUT', body }),
  archiveProduct: (id) => request(`/products/${id}?mode=archive`, { method: 'DELETE' }),
  purgeProduct: (id) => request(`/products/${id}?mode=purge`, { method: 'DELETE' }),
  restoreProduct: (id) => request(`/products/${id}/restore`, { method: 'POST' }),

  movements: (params) => request(`/movements${qs(params)}`),
  createMovement: (body) => request('/movements', { method: 'POST', body }),
  createBulkMovements: (body) => request('/movements/bulk', { method: 'POST', body }),
  deleteMovement: (id) => request(`/movements/${id}`, { method: 'DELETE' }),

  /* ---- procurement ---- */
  suppliers: (params) => request(`/suppliers${qs(params)}`),
  supplier: (id) => request(`/suppliers/${id}`),
  createSupplier: (body) => request('/suppliers', { method: 'POST', body }),
  updateSupplier: (id, body) => request(`/suppliers/${id}`, { method: 'PUT', body }),
  archiveSupplier: (id) => request(`/suppliers/${id}?mode=archive`, { method: 'DELETE' }),

  purchaseOrders: (params) => request(`/purchase-orders${qs(params)}`),
  purchaseOrder: (id) => request(`/purchase-orders/${id}`),
  createPurchaseOrder: (body) => request('/purchase-orders', { method: 'POST', body }),
  updatePurchaseOrder: (id, body) => request(`/purchase-orders/${id}`, { method: 'PUT', body }),
  sendPurchaseOrder: (id) => request(`/purchase-orders/${id}/transition`, { method: 'POST', body: { action: 'order' } }),
  cancelPurchaseOrder: (id) => request(`/purchase-orders/${id}/transition`, { method: 'POST', body: { action: 'cancel' } }),
  reopenPurchaseOrder: (id) => request(`/purchase-orders/${id}/transition`, { method: 'POST', body: { action: 'reopen' } }),
  receivePurchaseOrder: (id, body) => request(`/purchase-orders/${id}/receive`, { method: 'POST', body }),
  deletePurchaseOrder: (id) => request(`/purchase-orders/${id}?mode=archive`, { method: 'DELETE' }),

  suggestions: (params) => request(`/purchasing/suggestions${qs(params)}`),
  purchasingSummary: (params) => request(`/purchasing/summary${qs(params)}`),
  orderSuggestions: (body) => request('/purchasing/order', { method: 'POST', body }),

  /* ---- cycle counting ---- */
  counts: (params) => request(`/counts${qs(params)}`),
  count: (id) => request(`/counts/${id}`),
  createCount: (body) => request('/counts', { method: 'POST', body }),
  updateCount: (id, body) => request(`/counts/${id}`, { method: 'PUT', body }),
  postCount: (id, body) => request(`/counts/${id}/post`, { method: 'POST', body }),
  deleteCount: (id) => request(`/counts/${id}?mode=archive`, { method: 'DELETE' }),
  countExportUrl: (params) => `${BASE}/export.counts.csv${qs(params)}`,

  procurementExportUrl: (params) => `${BASE}/export.procurement.csv${qs(params)}`,
  reportSummary: (params) => request(`/reports/summary${qs(params)}`),
  reportValuation: (params) => request(`/reports/valuation${qs(params)}`),
  reportMovement: (params) => request(`/reports/movement${qs(params)}`),
  reportHealth: (params) => request(`/reports/health${qs(params)}`),
  reportActivity: (params) => request(`/reports/activity${qs(params)}`),

  exportUrl: (params) => `${BASE}/export.csv${qs(params)}`,
  /** Decorated PDF: attachment by default, `inline: 1` to open in the browser. */
  reportUrl: (params) => `${BASE}/report.pdf${qs(params)}`,
}

export const nf = new Intl.NumberFormat()
export const money = (n, currency = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n) || 0)
export const compact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0)
export const dateTime = (s) => {
  if (!s) return '—'
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
export const dayLabel = (s) => {
  if (!s) return ''
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
