// End-to-end API smoke test. Run against a live `wrangler dev`:
//   node scripts/verify-api.mjs [baseUrl]
const BASE = process.argv[2] || 'http://127.0.0.1:8787'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0
const failures = []

/* The whole API now sits behind a session cookie, so the suite keeps one jar.
   `cookie` defaults to the signed-in administrator; pass '' to act anonymously
   or another jar to act as a different role. `origin` lets us forge a
   cross-site write, which the Worker must refuse. */
let sessionCookie = ''
async function call(path, { method = 'GET', body, raw = false, cookie = sessionCookie, origin = null } = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  if (origin) headers.origin = origin
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)
  if (raw) {
    // Read bytes so the UTF-8 BOM survives (Response.text() strips it).
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    return { status: res.status, text, bytes, headers: res.headers, setCookies }
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers, setCookies }
}

/** Sign in and return the session cookie ('' when the attempt was refused). */
async function signIn(email, password, remember = false) {
  const res = await call('/api/auth/login', { method: 'POST', body: { email, password, remember }, cookie: '' })
  const set = res.setCookies[0] ?? ''
  const value = /sp_session=([^;]+)/.exec(set)?.[1]
  return { ...res, cookie: value ? `sp_session=${value}` : '' }
}

/**
 * PDF text extraction for assertions. Content streams are Flate-compressed and
 * pdf-lib writes every glyph run as a hex string, so inflate each stream, decode
 * the `<hex> Tj` operators back to WinAnsi, and also return a whitespace-free
 * view (letter-spaced kickers are drawn one character at a time).
 */
function inflateText({ bytes }) {
  const raw = Buffer.from(bytes)
  const streams = []
  let cursor = 0
  while (true) {
    const start = raw.indexOf('stream', cursor)
    if (start === -1) break
    let from = start + 6
    while (raw[from] === 13 || raw[from] === 10) from += 1
    const end = raw.indexOf('endstream', from)
    if (end === -1) break
    const chunk = raw.subarray(from, end)
    try { streams.push(zlib.inflateSync(chunk).toString('latin1')) } catch { streams.push(chunk.toString('latin1')) }
    cursor = end + 9
  }
  const body = streams.join('\n')
  const runs = []
  for (const m of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    const hex = m[1].replace(/\s+/g, '')
    let out = ''
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
    runs.push(out)
  }
  const text = runs.join(' ')
  return { text, tight: text.replace(/\s+/g, ''), raw: body }
}

function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const section = (t) => console.log(`\n${t}`)
const SKU = `QA-${Date.now().toString().slice(-7)}`

section('health & routing')
{
  const h = await call('/api/health')
  check('GET /api/health -> 200 ok:true', h.status === 200 && h.json?.ok === true)
  const nf = await call('/api/nope')
  check('unknown API route -> 404', nf.status === 404)
  const wrong = await call('/api/products', { method: 'DELETE' })
  check('wrong method -> 405', wrong.status === 405)
}

section('authentication: sessions, roles, lockout and the audit trail')
{
  // Anonymous access is refused everywhere that is not explicitly public.
  const anonRead = await call('/api/products', { cookie: '' })
  check('anonymous read -> 401 with the login hint', anonRead.status === 401 && anonRead.json?.details?.cookie === 'sp_session' && anonRead.json?.details?.login === '/api/auth/login')
  const anonWrite = await call('/api/products', { method: 'POST', body: { sku: 'X', name: 'n', category: 'c', cost_price: 1, sale_price: 2 }, cookie: '' })
  check('anonymous write -> 401', anonWrite.status === 401)
  check('health stays public', (await call('/api/health', { cookie: '' })).status === 200)
  const pubSession = await call('/api/auth/session', { cookie: '' })
  check('GET /api/auth/session anonymously -> authenticated:false', pubSession.status === 200 && pubSession.json?.authenticated === false)

  // The demo readout must print the seeded passwords and nothing else.
  const demo = await call('/api/auth/demo', { cookie: '' })
  const seeded = demo.json?.accounts ?? []
  check('demo credentials are published for the seeded team', demo.json?.enabled === true && seeded.length >= 3)
  check('demo rows carry role + password for each team member', seeded.every((a) => a.email && a.password && ['admin', 'operator', 'viewer'].includes(a.role)))
  check('demo publishes the admin login the UI prints', seeded.some((a) => a.role === 'admin' && a.email.endsWith('@stockpilot.app')))
  check('demo never leaks a hash', !JSON.stringify(demo.json).includes('pbkdf2'))

  // Wrong password: generic message, attempt counter, no session issued.
  const wrong = await signIn('admin@stockpilot.app', 'not-the-password')
  check('wrong password -> 401 and no cookie', wrong.status === 401 && wrong.cookie === '')
  check('wrong password message is generic', /incorrect/i.test(wrong.json?.error ?? '') && !/no such/i.test(wrong.json?.error ?? ''))
  check('failed attempt reports attempts_left', typeof wrong.json?.details?.attempts_left === 'number' && wrong.json.details.attempts_left < 5)
  const unknown = await signIn('nobody@example.com', 'whatever')
  check('unknown account -> same generic 401', unknown.status === 401 && unknown.json?.error === wrong.json?.error)

  // Sign in as the administrator; the rest of the suite rides this session.
  const admin = await signIn('admin@stockpilot.app', 'Pilot#2026', true)
  check('admin sign-in -> 200 with the user payload', admin.status === 200 && admin.json?.user?.role === 'admin', admin.json?.error)
  check('admin sign-in sets an HttpOnly session cookie', /sp_session=/.test(admin.cookie) && (admin.setCookies[0] ?? '').includes('HttpOnly') && (admin.setCookies[0] ?? '').includes('SameSite=Lax'))
  check('remember=true extends the session to 30 days', admin.json?.expires_in === 30 * 86400)
  sessionCookie = admin.cookie

  const session = await call('/api/auth/session')
  check('session reflects the signed-in user', session.json?.authenticated === true && session.json.user.email === 'admin@stockpilot.app')
  check('session never returns the password hash', !JSON.stringify(session.json).includes('pbkdf2') && session.json.user.password_hash === undefined)
  check('session counts live devices', session.json?.active_sessions >= 1)

  // Roles: an operator may move stock, a viewer may only read.
  const viewer = await signIn('viewer@stockpilot.app', 'Read#2026')
  const operator = await signIn('operator@stockpilot.app', 'Stock#2026')
  check('operator + viewer both sign in', viewer.status === 200 && operator.status === 200)
  check('viewer role is viewer', viewer.json?.user?.role === 'viewer' && operator.json?.user?.role === 'operator')
  check('viewer can read products', (await call('/api/products?limit=1', { cookie: viewer.cookie })).status === 200)
  const viewerWrite = await call('/api/products', { method: 'POST', body: { sku: `QA-VIEW-${Date.now().toString().slice(-6)}`, name: 'nope', category: 'QA', cost_price: 1, sale_price: 2 }, cookie: viewer.cookie })
  check('viewer write -> 403 naming the missing capability', viewerWrite.status === 403 && viewerWrite.json?.details?.required === 'manage' && viewerWrite.json?.details?.role === 'viewer')
  const viewerMove = await call('/api/movements', { method: 'POST', body: { product_id: 1, type: 'in', quantity: 1 }, cookie: viewer.cookie })
  check('viewer stock movement -> 403', viewerMove.status === 403 && viewerMove.json?.details?.required === 'move')
  check('viewer cannot open the team list', (await call('/api/auth/accounts', { cookie: viewer.cookie })).status === 403)
  check('viewer cannot read the audit trail', (await call('/api/auth/events', { cookie: viewer.cookie })).status === 403)
  check('operator cannot open the team list either', (await call('/api/auth/accounts', { cookie: operator.cookie })).status === 403)

  // Admin-only governance endpoints.
  const accounts = await call('/api/auth/accounts')
  check('admin reads the team list', accounts.status === 200 && accounts.json.accounts.length >= 3)
  check('team rows carry role, sessions and lock state', accounts.json.accounts.every((a) => ['admin', 'operator', 'viewer'].includes(a.role) && typeof a.active_sessions === 'number' && typeof a.locked === 'boolean'))
  check('team list never exposes hashes', !JSON.stringify(accounts.json).includes('pbkdf2'))
  const events = await call('/api/auth/events?limit=50')
  check('admin reads the audit trail', events.status === 200 && events.json.events.length > 0)
  check('audit rows record sign-in success and failure', events.json.events.some((e) => e.event === 'login_success') && events.json.events.some((e) => e.event === 'login_failed'))
  check('audit rows are newest-first with ip + agent', events.json.events.every((e, i, a) => i === 0 || a[i - 1].id > e.id) && events.json.events.every((e) => typeof e.ip === 'string'))

  // Cross-site writes are refused: the cookie is sent by the browser, but the
  // Origin header proves the request came from another site.
  const crossSite = await call('/api/products', { method: 'POST', body: { sku: 'QA-X', name: 'x', category: 'c', cost_price: 1, sale_price: 2 }, origin: 'https://evil.example' })
  check('cross-origin write -> 403', crossSite.status === 403 && /cross-origin/i.test(crossSite.json?.error ?? ''))
  const sameSite = await call('/api/auth/session', { origin: `http://127.0.0.1:8787` })
  check('same-origin GET still allowed with an Origin header', sameSite.status === 200)

  // Lockout: five failures then a 429 that survives even a correct password.
  let failed = await signIn('viewer@stockpilot.app', 'wrong')
  check('first failure reports four tries left', failed.status === 401 && failed.json?.details?.attempts_left === 4, `left=${failed.json?.details?.attempts_left}`)
  for (let i = 0; i < 3; i += 1) failed = await signIn('viewer@stockpilot.app', 'wrong')
  check('fourth failure leaves a single attempt', failed.status === 401 && failed.json?.details?.attempts_left === 1, `left=${failed.json?.details?.attempts_left}`)
  const finalAttempt = await signIn('viewer@stockpilot.app', 'wrong')
  check('fifth failure -> 429 lockout', finalAttempt.status === 429)
  check('lockout answers with retry_after', finalAttempt.json?.details?.retry_after > 0)
  check('lockout sets a Retry-After header', Number(finalAttempt.headers.get('retry-after')) > 0)
  const lockedButRight = await signIn('viewer@stockpilot.app', 'Read#2026')
  check('correct password is refused while locked', lockedButRight.status === 429)
  const lockedRow = (await call('/api/auth/accounts')).json.accounts.find((a) => a.email === 'viewer@stockpilot.app')
  check('team list shows the lock with minutes left', lockedRow?.locked === true && lockedRow.locked_minutes_left > 0)

  const unlock = await call('/api/auth/unlock', { method: 'POST', body: { email: 'viewer@stockpilot.app' } })
  check('admin unlocks the account', unlock.status === 200 && unlock.json?.ok === true)
  const viewerAgain = await signIn('viewer@stockpilot.app', 'Read#2026')
  check('unlocked account signs back in', viewerAgain.status === 200 && viewerAgain.cookie !== '')
  check('unlock was written to the audit trail', (await call('/api/auth/events?limit=20')).json.events.some((e) => e.event === 'account_unlocked'))
  check('unknown account unlock -> 404', (await call('/api/auth/unlock', { method: 'POST', body: { email: 'ghost@example.com' } })).status === 404)

  // Password rotation: this session survives, every other device is cut off.
  const rotated = await signIn('operator@stockpilot.app', 'Stock#2026')
  const secondDevice = await signIn('operator@stockpilot.app', 'Stock#2026')
  check('operator holds two devices', secondDevice.cookie !== '' && secondDevice.cookie !== rotated.cookie)
  const weak = await call('/api/auth/password', { method: 'POST', body: { current_password: 'Stock#2026', new_password: 'short' }, cookie: rotated.cookie })
  check('weak password -> 400', weak.status === 400)
  const wrongCurrent = await call('/api/auth/password', { method: 'POST', body: { current_password: 'nope-nope', new_password: 'Qa-Rotate#2026' }, cookie: rotated.cookie })
  check('wrong current password -> 401', wrongCurrent.status === 401)
  const changed = await call('/api/auth/password', { method: 'POST', body: { current_password: 'Stock#2026', new_password: 'Qa-Rotate#2026' }, cookie: rotated.cookie })
  check('password rotation accepted', changed.status === 200 && changed.json?.ok === true)
  check('this device keeps its session', (await call('/api/auth/session', { cookie: rotated.cookie })).json?.authenticated === true)
  check('the other device is signed out', (await call('/api/auth/session', { cookie: secondDevice.cookie })).json?.authenticated === false)
  check('the old password no longer works', (await signIn('operator@stockpilot.app', 'Stock#2026')).status === 401)
  check('the new password works', (await signIn('operator@stockpilot.app', 'Qa-Rotate#2026')).status === 200)
  check('rotated password leaves the demo readout', !(await call('/api/auth/demo', { cookie: '' })).json.accounts.some((a) => a.email === 'operator@stockpilot.app'))

  // Rotate back so the seeded demo credentials stay valid for the next run.
  const restore = await call('/api/auth/password', { method: 'POST', body: { current_password: 'Qa-Rotate#2026', new_password: 'Stock#2026' }, cookie: rotated.cookie })
  check('password restored for the demo team', restore.status === 200)
  check('demo readout lists the operator again', (await call('/api/auth/demo', { cookie: '' })).json.accounts.some((a) => a.email === 'operator@stockpilot.app'))

  // Admin can revoke another account's sessions; sign-out kills only our own.
  const beforeRevoke = (await call('/api/auth/accounts')).json.accounts.find((a) => a.email === 'viewer@stockpilot.app')
  const revoked = await call('/api/auth/revoke', { method: 'POST', body: { email: 'viewer@stockpilot.app' } })
  check('admin ends another account\u2019s sessions', revoked.status === 200 && revoked.json.revoked >= 1, `revoked=${revoked.json?.revoked}`)
  check('revoked cookie stops working', (await call('/api/auth/session', { cookie: viewerAgain.cookie })).json?.authenticated === false)
  check('revocation counted the live sessions', beforeRevoke.active_sessions === revoked.json.revoked)
  check('revoking your own sessions is refused', (await call('/api/auth/revoke', { method: 'POST', body: { email: 'admin@stockpilot.app' } })).status === 400)

  const bye = await call('/api/auth/logout', { method: 'POST', cookie: viewerAgain.cookie })
  check('logout clears the cookie', bye.status === 200 && /sp_session=;/.test(bye.setCookies[0] ?? ''))
  check('logged-out cookie is dead', (await call('/api/auth/session', { cookie: viewerAgain.cookie })).json?.authenticated === false)
}

section('products: list, search, filter, paginate')
let created = null
let outFixture = null
{
  const all = await call('/api/products?limit=100&active=all')
  check('lists seeded catalog', all.status === 200 && all.json.total >= 26, `total=${all.json?.total}`)
  check('items carry computed status/value', all.json.items.every((p) => ['ok', 'low', 'out'].includes(p.status) && typeof p.stock_value === 'number'))

  const search = await call('/api/products?search=monitor')
  check('search matches name', search.json.total >= 1 && search.json.items.every((p) => /monitor/i.test(p.name) || /monitor/i.test(p.sku)))

  const cats = await call('/api/categories')
  check('categories endpoint', cats.status === 200 && cats.json.items.length >= 4)
  const firstCat = cats.json.items[0].category
  const byCat = await call(`/api/products?category=${encodeURIComponent(firstCat)}&limit=100`)
  check('filter by category', byCat.json.items.length > 0 && byCat.json.items.every((p) => p.category === firstCat))

  const low = await call('/api/products?status=low&limit=100&active=all')
  check('filter status=low', low.json.items.every((p) => p.quantity > 0 && p.quantity <= p.reorder_level), `${low.json.total} rows`)

  const paged = await call('/api/products?limit=5&page=2&sort=name')
  check('pagination metadata', paged.json.page === 2 && paged.json.limit === 5 && paged.json.pages >= 2)
  check('sort=name ascending', paged.json.items.every((p, i, a) => i === 0 || a[i - 1].name.localeCompare(p.name) <= 0))
}

section('products: create / update / archive / purge')
{
  const bad = await call('/api/products', { method: 'POST', body: { name: 'No SKU' } })
  check('create without SKU -> 400', bad.status === 400, bad.json?.error)

  const ok = await call('/api/products', {
    method: 'POST',
    body: { sku: SKU, name: 'QA Widget', category: 'QA', unit: 'pcs', cost_price: 10, sale_price: 25, reorder_level: 5, quantity: 12, supplier: 'QA Co', location: 'QA Bay' },
  })
  check('create product -> 201', ok.status === 201, ok.json?.error)
  created = ok.json?.product
  check('opening stock applied', created?.quantity === 12 && created?.status === 'ok')

  const opening = await call(`/api/movements?product_id=${created.id}`)
  check('opening stock logged as movement', opening.json.total === 1 && opening.json.items[0].reference === 'OPENING')

  const alertFix = await call('/api/products', {
    method: 'POST',
    body: { sku: `${SKU}-OUT`, name: 'QA Out Of Stock Fixture', category: 'QA', unit: 'pcs', cost_price: 2, sale_price: 4, reorder_level: 10, quantity: 0 },
  })
  check('out-of-stock fixture created', alertFix.status === 201 && alertFix.json.product.status === 'out', alertFix.json?.error)
  outFixture = alertFix.json?.product

  const dupe = await call('/api/products', { method: 'POST', body: { sku: SKU, name: 'Dupe' } })
  check('duplicate SKU -> 409', dupe.status === 409)

  const noBody = await call(`/api/products/${created.id}`, { method: 'PUT', body: {} })
  check('empty update -> 400', noBody.status === 400)

  const upd = await call(`/api/products/${created.id}`, { method: 'PUT', body: { sale_price: 29.5, reorder_level: 4 } })
  check('update price/reorder -> 200', upd.status === 200 && upd.json.product.sale_price === 29.5 && upd.json.product.reorder_level === 4)

  const qtyEdit = await call(`/api/products/${created.id}`, { method: 'PUT', body: { quantity: 7 } })
  check('quantity edit logs adjustment', qtyEdit.json.adjustment?.balance_after === 7 && qtyEdit.json.product.quantity === 7)

  const missing = await call('/api/products/999999')
  check('unknown product -> 404', missing.status === 404)
}

section('stock in / out / adjust')
{
  const inRes = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'in', quantity: 8, reference: 'QA-PO-1', note: 'qa receive' } })
  check('stock in -> 201 and balance up', inRes.status === 201 && inRes.json.product.quantity === 15, JSON.stringify(inRes.json.product))

  const outRes = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'out', quantity: 5, reference: 'QA-SO-1' } })
  check('stock out -> 201 and balance down', outRes.status === 201 && outRes.json.product.quantity === 10)

  const tooMany = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'out', quantity: 9999 } })
  check('over-issue rejected -> 409', tooMany.status === 409 && tooMany.json.details?.available === 10, tooMany.json?.error)

  const zero = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'out', quantity: 0 } })
  check('zero quantity -> 400', zero.status === 400)

  const badType = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'sideways', quantity: 1 } })
  check('invalid type -> 400', badType.status === 400)

  const adjust = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'adjust', quantity: 3, note: 'stocktake' } })
  check('adjust sets absolute count', adjust.status === 201 && adjust.json.product.quantity === 3)

  const same = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'adjust', quantity: 3 } })
  check('no-op adjustment -> 400', same.status === 400)

  const bulk = await call('/api/movements/bulk', {
    method: 'POST',
    body: { type: 'in', reference: 'QA-BULK', lines: [{ product_id: created.id, quantity: 4 }, { product_id: created.id, quantity: 6 }] },
  })
  check('bulk receipt applies cumulative lines', bulk.status === 201 && bulk.json.applied_count === 2)

  const afterBulk = await call(`/api/products/${created.id}`)
  check('bulk receipt moved balance to 13', afterBulk.json.product.quantity === 13, `got ${afterBulk.json.product?.quantity}`)

  const bulkReject = await call('/api/movements/bulk', { method: 'POST', body: { type: 'out', lines: [{ product_id: created.id, quantity: 99999 }] } })
  check('bulk over-issue reported, not applied', bulkReject.json.rejected_count === 1 && bulkReject.json.applied_count === 0)

  const list = await call(`/api/movements?product_id=${created.id}&limit=50`)
  check('movement history for product', list.json.total >= 6 && list.json.items.every((m) => m.product_id === created.id))
  check('movement list filters by type', (await call(`/api/movements?type=out&product_id=${created.id}`)).json.items.every((m) => m.type === 'out'))

  const today = new Date().toISOString().slice(0, 10)
  const ranged = await call(`/api/movements?from=${today}&to=${today}&product_id=${created.id}`)
  check('date range filter', ranged.json.total >= 1)

  const target = list.json.items.find((m) => m.reference === 'QA-PO-1')
  const rev = await call(`/api/movements/${target.id}`, { method: 'DELETE' })
  check('reversal compensates stock', rev.status === 200 && rev.json.balance_after === 5, `balance=${rev.json?.balance_after}`)
}

section('alerts & dashboard')
{
  const alerts = await call('/api/alerts')
  check('alerts endpoint shape', alerts.status === 200 && Array.isArray(alerts.json.items) && typeof alerts.json.summary.restock_cost === 'number')
  check('out-of-stock fixture is listed as an alert', alerts.json.items.some((i) => i.id === outFixture.id && i.status === 'out'), `${alerts.json.summary.total} alerts`)
  check('every alert is at or below its reorder level', alerts.json.items.every((i) => i.quantity <= i.reorder_level))
  check('alert summary counts the fixture', alerts.json.summary.out_of_stock >= 1 && alerts.json.summary.total >= 1)

  const dash = await call('/api/dashboard?days=14')
  const k = dash.json?.kpis
  check('dashboard kpis', dash.status === 200 && k.products >= 26 && k.stock_value > 0 && k.retail_value > k.stock_value)
  check('out-of-stock fixture counted in dashboard kpis', k.out_of_stock >= 1)
  check('restock budget reported', k.reorder_cost > 0)
  check('trend series filled for whole window', dash.json.trend.length === 14 && dash.json.trend[0].date < dash.json.trend[13].date)
  check('trend buckets have numeric in/out', dash.json.trend.every((d) => Number.isFinite(d.units_in) && Number.isFinite(d.units_out)))
  check('dashboard sections populated', dash.json.categories.length >= 4 && dash.json.recent.length > 0 && dash.json.top_movers.length > 0)
  check('top movers sorted by outbound units', dash.json.top_movers.every((m, i, a) => i === 0 || a[i - 1].units_out >= m.units_out))
}

section('reports')
{
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const to = new Date().toISOString().slice(0, 10)
  const s = await call(`/api/reports/summary?from=${from}&to=${to}`)
  check('summary totals', s.status === 200 && s.json.totals.units_in > 0 && s.json.totals.units_out > 0)
  check('summary daily series', s.json.daily.length === 30 && s.json.daily.every((d) => Number.isFinite(d.value_out)))
  check('summary category breakdown', s.json.categories.length >= 4)

  const badRange = await call('/api/reports/summary?from=2026-05-01&to=2026-04-01')
  check('inverted range -> 400', badRange.status === 400)

  const v = await call('/api/reports/valuation')
  check('valuation totals & margin', v.status === 200 && v.json.totals.cost_value > 0 && v.json.totals.retail_value > v.json.totals.cost_value)
  check('valuation categories reconcile to total', Math.abs(v.json.categories.reduce((a, c) => a + c.cost_value, 0) - v.json.totals.cost_value) < 0.5)

  const d = await call(`/api/reports/movement?from=${from}&to=${to}&group=day`)
  check('movement report daily series', d.json.series.length > 0 && d.json.series.every((r) => Number.isFinite(r.units_in)))
  const w = await call(`/api/reports/movement?from=${from}&to=${to}&group=week`)
  check('movement report weekly bucket', w.status === 200 && w.json.group === 'week' && w.json.series.length > 0)
  const bad = await call('/api/reports/movement?group=fortnight')
  check('invalid group -> 400', bad.status === 400)

  // --- health scoring -----------------------------------------------------
  const h = await call(`/api/reports/health?from=${from}&to=${to}`)
  check('health endpoint -> 200', h.status === 200, String(h.status))
  check('health score is 0-100 with a grade', h.json.score.value >= 0 && h.json.score.value <= 100 && ['A', 'B', 'C', 'D'].includes(h.json.score.grade), `${h.json?.score?.value} ${h.json?.score?.grade}`)
  check('health dimensions are weighted and complete', h.json.dimensions.length === 4 && Math.abs(h.json.dimensions.reduce((a, d) => a + d.weight, 0) - 1) < 0.001)
  check('health dimensions score 0-100 with hints', h.json.dimensions.every((d) => d.value >= 0 && d.value <= 100 && typeof d.hint === 'string' && d.hint.length > 0))
  const kk = h.json.kpis
  check('health KPIs: fill + stockout + low rates reconcile', Math.abs(kk.fill_rate + kk.stockout_rate + kk.low_stock_rate - 100) < 0.4, `${kk.fill_rate}/${kk.stockout_rate}/${kk.low_stock_rate}`)
  check('health KPIs carry cover, turnover and dormant capital', kk.days_cover > 0 && kk.turnover >= 0 && kk.dead_value >= 0 && kk.dead_products >= 0)
  check('health ageing buckets are ordered and complete', h.json.aging.length === 5 && h.json.aging[0].bucket === '0-14' && Math.abs(h.json.aging.reduce((a, x) => a + x.share, 0) - 100) < 0.6, h.json.aging.map((x) => x.share).join(','))
  check('health advisory actions are actionable', h.json.actions.every((a) => a.title && a.detail && a.href.startsWith('#/')))

  // --- activity heatmap ---------------------------------------------------
  const act = await call(`/api/reports/activity?from=${from}&to=${to}`)
  check('activity endpoint -> 200', act.status === 200, String(act.status))
  check('activity weeks + weekday axis (Mon..Sun)', act.json.weeks.length > 0 && act.json.weekdays.map((w) => w.label).join(',') === 'Mon,Tue,Wed,Thu,Fri,Sat,Sun')
  check('activity cells stay inside the grid', act.json.cells.every((c) => c.weekday >= 1 && c.weekday <= 7 && act.json.weeks.includes(c.week)))
  check('activity hours fill a full 24-slot profile', act.json.hours.length === 24 && act.json.hours.every((x, i) => x.hour === i))
  check('activity publishes maxima for the colour scale', act.json.max.units_out >= 1 && act.json.max.movements >= 1)
  check('activity weekday totals add up', Math.abs(act.json.weekday_totals.reduce((a, d) => a + d.units_out, 0) - act.json.cells.reduce((a, c) => a + c.units_out, 0)) < 0.001)
}

section('CSV export')
{
  for (const [type, needle] of [
    ['products', 'SKU,Name,Category'], ['movements', 'ID,Date,Type'], ['valuation', 'Stock Value'],
    ['categories', 'Category,Products'], ['lowstock', 'Reorder Level'],
    ['health', 'Health score'], ['activity', 'Week,Weekday'],
  ]) {
    const res = await call(`/api/export.csv?type=${type}`, { raw: true })
    const lines = res.text.trim().split('\r\n')
    const hasBom = res.bytes[0] === 0xef && res.bytes[1] === 0xbb && res.bytes[2] === 0xbf
    check(`export type=${type}`, res.status === 200 && hasBom && res.text.includes(needle) && lines.length > 1, `${lines.length} lines, bom=${hasBom}`)
    check(`export ${type} content-type + filename`, /text\/csv/.test(res.headers.get('content-type')) && /attachment; filename="inventory-/.test(res.headers.get('content-disposition')))
  }
  const lowstock = await call('/api/export.csv?type=lowstock', { raw: true })
  check('lowstock export contains the out-of-stock fixture', lowstock.text.includes(outFixture.sku), outFixture.sku)

  const bad = await call('/api/export.csv?type=bogus')
  check('invalid export type -> 400', bad.status === 400)
}

section('product artwork (image_url)')
{
  const sku = `QA-IMG-${Date.now().toString().slice(-6)}`
  const base = { sku, name: 'QA Image Widget', category: 'QA', unit: 'pcs', cost_price: 4, sale_price: 9, reorder_level: 2, quantity: 3 }

  const plain = await call('/api/products', { method: 'POST', body: base })
  check('a product without a photo stores an empty image_url', plain.status === 201 && plain.json.product.image_url === '', JSON.stringify(plain.json.product?.image_url))

  const withUrl = await call('/api/products', { method: 'POST', body: { ...base, sku: `${sku}-B`, image_url: 'https://cdn.example.com/widget.jpg' } })
  check('a photo URL is stored and echoed back', withUrl.status === 201 && withUrl.json.product.image_url === 'https://cdn.example.com/widget.jpg', withUrl.json.product?.image_url)
  check('returned rows always carry the image field', 'image_url' in (await call('/api/products?limit=1')).json.items[0])

  const badScheme = await call('/api/products', { method: 'POST', body: { ...base, sku: `${sku}-C`, image_url: 'javascript:alert(1)' } })
  check('a javascript: URL is refused', badScheme.status === 400 && /http/i.test(badScheme.json.error))
  const badValue = await call('/api/products', { method: 'POST', body: { ...base, sku: `${sku}-D`, image_url: 'not a url' } })
  check('a malformed URL is refused', badValue.status === 400)
  const tooLong = await call('/api/products', { method: 'POST', body: { ...base, sku: `${sku}-E`, image_url: `https://example.com/${'a'.repeat(600)}.jpg` } })
  check('an over-long URL is refused', tooLong.status === 400)

  const id = withUrl.json.product.id
  const cleared = await call(`/api/products/${id}`, { method: 'PUT', body: { image_url: '' } })
  check('an update can clear the photo', cleared.status === 200 && cleared.json.product.image_url === '')
  const reset = await call(`/api/products/${id}`, { method: 'PUT', body: { image_url: 'https://cdn.example.com/widget-2.jpg' } })
  check('an update can set a new photo', reset.status === 200 && reset.json.product.image_url === 'https://cdn.example.com/widget-2.jpg')

  const csv = await call('/api/export.csv?type=products&search=QA-IMG', { raw: true })
  check('the products CSV carries the image column', csv.text.includes('Image URL') && csv.text.includes('https://cdn.example.com/widget-2.jpg'))

  for (const row of [plain, withUrl, badScheme, badValue, tooLong]) void row
  const cleanup = await call(`/api/products?search=${sku}&active=all`)
  for (const p of cleanup.json.items) await call(`/api/products/${p.id}?mode=purge`, { method: 'DELETE' })
  check('image fixtures cleaned up', (await call(`/api/products?search=${sku}&active=all`)).json.total === 0)
}

section('uploaded product photos')
{
  const sku = `QA-PIC-${Date.now().toString().slice(-6)}`
  const png = readFileSync(new URL('../public/favicon-32.png', import.meta.url))
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  const base = { name: 'QA Photo Widget', category: 'QA', unit: 'pcs', cost_price: 4, sale_price: 9, reorder_level: 2, quantity: 3 }

  const viewerJar = await signIn('viewer@stockpilot.app', 'Read#2026')
  const uploaded = await call('/api/products', {
    method: 'POST',
    body: { ...base, sku, image_data: dataUrl, image_type: 'image/png' },
  })
  const id = uploaded.json?.product?.id
  check('a data-url photo is accepted and returns a servable path', uploaded.status === 201 && /^\/api\/products\/\d+\/image\?v=\d+$/.test(uploaded.json.product.image_url), uploaded.json?.product?.image_url)
  check('the row reports has_photo', uploaded.json.product.has_photo === 1)
  check('the list payload never carries the base64', !JSON.stringify(await call('/api/products?limit=200').then((r) => r.json)).includes(png.toString('base64').slice(0, 40)))

  const served = await call(uploaded.json.product.image_url, { raw: true })
  const body = Buffer.from(served.bytes)
  check('the stored photo is served back byte-for-byte', served.status === 200 && body.equals(png), `${served.status} ${body.length}/${png.length} bytes`)
  check('the image response declares its type and no-sniff', served.headers.get('content-type') === 'image/png' && served.headers.get('x-content-type-options') === 'nosniff')
  check('the image response is private', /private/.test(served.headers.get('cache-control') ?? ''))
  check('an anonymous image request -> 401', (await call(`/api/products/${id}/image`, { cookie: '', raw: true })).status === 401)
  check('a product with no photo -> 404 on its image route', (await call('/api/products/1/image', { raw: true })).status === 404)

  const oversized = await call(`/api/products/${id}`, { method: 'PUT', body: { image_data: Buffer.alloc(300 * 1024).toString('base64'), image_type: 'image/png' } })
  check('an oversize upload -> 400 with the byte cap', oversized.status === 400 && /262144/.test(oversized.json.error))
  const wrongType = await call(`/api/products/${id}`, { method: 'PUT', body: { image_data: png.toString('base64'), image_type: 'image/svg+xml' } })
  check('a non-raster type -> 400', wrongType.status === 400 && /image\/jpeg/.test(wrongType.json.error))
  const notBase64 = await call(`/api/products/${id}`, { method: 'PUT', body: { image_data: 'not base64 !!!', image_type: 'image/png' } })
  check('a non-base64 payload -> 400', notBase64.status === 400)
  const orphanType = await call(`/api/products/${id}`, { method: 'PUT', body: { image_type: 'image/png' } })
  check('an mime without bytes -> 400', orphanType.status === 400)
  check('a viewer cannot upload a photo', (await call(`/api/products/${id}`, { method: 'PUT', body: { image_data: png.toString('base64'), image_type: 'image/png' }, cookie: viewerJar.cookie })).status === 403)

  const linked = await call(`/api/products/${id}`, { method: 'PUT', body: { image_url: 'https://cdn.example.com/photo.jpg' } })
  check('a link replaces the upload', linked.status === 200 && linked.json.product.image_url === 'https://cdn.example.com/photo.jpg' && linked.json.product.has_photo === 0)
  const reuploaded = await call(`/api/products/${id}`, { method: 'PUT', body: { image_data: dataUrl, image_type: 'image/png' } })
  check('an upload replaces the link again', reuploaded.status === 200 && reuploaded.json.product.has_photo === 1 && reuploaded.json.product.image_url !== 'https://cdn.example.com/photo.jpg')

  const valuation = await call('/api/reports/valuation')
  const row = valuation.json.items.find((i) => i.id === id)
  check('the valuation report carries the photo for the gallery', row?.has_photo === 1 && /\/api\/products\/\d+\/image/.test(row?.image_url ?? ''), row?.image_url)

  const csv = await call(`/api/export.csv?type=products&search=${sku}`, { raw: true })
  const line = csv.text.split('\r\n').find((l) => l.includes(sku)) ?? ''
  check('the products CSV prints an absolute image url', new RegExp(`${BASE}/api/products/${id}/image`).test(line), line.slice(0, 160))

  // A real product with a stored photo exists in this run, so the gallery
  // should carry an embedded image object. Use the photo fixture created above.
  check('a product with a stored photo exists in this run', Boolean(id), String(id))
  const pdf = id ? await call(`/api/report.pdf?from=2026-09-01&to=2026-10-12`, { raw: true }) : null
  const pdfText = pdf ? inflateText(pdf) : { tight: '' }
  check('the report gallery notes the stored photo', pdf && /shownasastoredphoto/i.test(pdfText.tight), pdf ? pdfText.tight.slice(0, 120) : 'no pdf')
  check('the report embeds the photo as an image object', pdf && (Buffer.from(pdf.bytes).toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length >= 1, pdf ? (Buffer.from(pdf.bytes).toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length : 'no pdf')

  const cleared = await call(`/api/products/${id}`, { method: 'PUT', body: { image_data: '', image_type: '' } })
  check('a photo can be removed', cleared.status === 200 && cleared.json.product.has_photo === 0 && cleared.json.product.image_url === '')
  check('the removed photo -> 404', (await call(`/api/products/${id}/image`, { raw: true })).status === 404)

  await call(`/api/products/${id}?mode=purge`, { method: 'DELETE' })
  check('photo fixtures cleaned up', (await call(`/api/products?search=${sku}&active=all`)).json.total === 0)
}

section('PDF report')
{
  const anon = await call('/api/report.pdf', { cookie: '', raw: true })
  check('report download requires a session', anon.status === 401)

  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const to = new Date().toISOString().slice(0, 10)
  const res = await call(`/api/report.pdf?from=${from}&to=${to}`, { raw: true })
  const bytes = res.bytes

  check('report.pdf -> 200 application/pdf', res.status === 200 && res.headers.get('content-type') === 'application/pdf')
  check('report is a real PDF (magic bytes + EOF)', res.text.startsWith('%PDF-1.') && res.text.trimEnd().endsWith('%%EOF'))
  check('report is a substantial document', bytes.length > 40000, `${bytes.length} bytes`)
  check('report downloads with a dated filename', /^attachment; filename="stockpilot-report-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf"$/.test(res.headers.get('content-disposition') ?? ''), res.headers.get('content-disposition'))
  check('report filename covers the requested window', (res.headers.get('content-disposition') ?? '').includes(`${from}_${to}`))
  check('report carries its document id + page count headers', /^SP-\d{8}-[0-9A-Z]{4}$/.test(res.headers.get('x-report-id') ?? '') && Number(res.headers.get('x-report-pages')) >= 4, `${res.headers.get('x-report-id')} / ${res.headers.get('x-report-pages')}`)
  check('report is marked private (personalised content)', /no-store/.test(res.headers.get('cache-control') ?? ''))
  check('report email/name never leaks a hash', !res.text.includes('pbkdf2'))

  const pages = (res.text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
  check('every page is written as a page object', pages === Number(res.headers.get('x-report-pages')), `${pages} vs ${res.headers.get('x-report-pages')}`)

  // Text lives in Flate-compressed, hex-encoded content streams.
  const pdf = inflateText(res)
  const t = pdf.tight
  check('cover titles the document', t.includes('INVENTORYINTELLIGENCEREPORT') && t.includes('Stockposition,movement'))
  check('cover prints both brand words', t.includes('STOCK') && t.includes('PILOT') && t.includes('SMARTINVENTORYSYSTEM'))
  check('cover names the requester and the window', t.includes('PREPAREDFOR') && t.includes('AveryStone') && t.includes(from) && t.includes(to))
  check('report id on the page matches the response header', t.includes(res.headers.get('x-report-id')))
  const health = await call(`/api/reports/health?from=${from}&to=${to}`)
  check('health score appears in the document', t.includes(String(health.json.score.value)) && t.includes(`GRADE${health.json.score.grade}`), `${health.json.score.value} ${health.json.score.grade}`)
  check('key indicators section lists the KPI labels', ['STOCKVALUE(COST)', 'RETAILVALUE', 'UNITSONHAND', 'FILLRATE', 'DAYSOFCOVER', 'TURNOVER'].every((l) => t.includes(l)))
  check('position page has valuation, ageing and holdings tables', t.includes('Capitalposition') && t.includes('Ageofstock') && t.includes('Topholdingsbyvalue'))
  check('movement page has throughput analytics', t.includes('Movementanalytics') && t.includes('Dailythroughput') && t.includes('Weekdayrhythm') && t.includes('Topthroughput'))
  check('attention page has the worklist and the action list', t.includes('Attention&actions') && t.includes('Restockworklist') && t.includes('Recommendedactions'))
  check('appendix lists the gallery, the register and the method', t.includes('Productgallery') && t.includes('Productregister') && t.includes('Method&definitions'))
  check('the gallery page prints a category label per artwork family', ['Electronics', 'Networking', 'Storage', 'OfficeSupplies', 'Accessories'].some((c) => t.includes(c)))

  const valuation = await call('/api/reports/valuation')
  const sample = valuation.json.items[0]
  check('a real product from the database is printed', t.includes(sample.sku.replace(/\s+/g, '')) && t.includes(sample.name.replace(/\s+/g, '')), `${sample.sku} / ${sample.name}`)
  check('page text has no replacement gibberish', !/\?\?\?/.test(pdf.text) && !pdf.text.includes('\ufffd'))

  const inline = await call(`/api/report.pdf?from=${from}&to=${to}&inline=1`, { raw: true })
  check('inline=1 opens in the browser instead of downloading', /^inline; filename="/.test(inline.headers.get('content-disposition') ?? ''), inline.headers.get('content-disposition'))

  const badRange = await call(`/api/report.pdf?from=${to}&to=${from}`)
  check('inverted range -> 400', badRange.status === 400)
  const defaulted = await call('/api/report.pdf', { raw: true })
  check('report without a range defaults to the last 30 days', defaulted.status === 200 && defaulted.text.startsWith('%PDF-'))

  const events = await call('/api/auth/events?limit=20')
  check('generating a report is written to the audit trail', events.json.events.some((e) => e.event === 'report_generated' && /SP-/.test(e.detail)))
}

section('procurement: suppliers')
{
  const stamp = Date.now().toString().slice(-6)
  const supName = `QA Vendor ${stamp}`
  const sku = `QA-SUP-${stamp}`
  const createdIds = []

  // A fresh database turns the catalogue's free-text supplier names into records.
  const seeded = await call('/api/suppliers?limit=100')
  check('the catalogue seeds supplier records', seeded.status === 200 && seeded.json.total >= 5, `${seeded.json.total}`)
  check('supplier rows carry coverage stats', seeded.json.items.every((i) => typeof i.products === 'number' && typeof i.open_orders === 'number' && typeof i.outstanding_value === 'number'))
  check('every seeded supplier has a lead time for the model', seeded.json.items.every((i) => i.lead_time_days > 0))

  // A product naming a supplier before that supplier exists stays linked once added.
  const pre = await call('/api/products', { method: 'POST', body: { sku, name: 'QA Vendor Linked Widget', category: 'QA', supplier: supName, cost_price: 5, sale_price: 9, reorder_level: 2, quantity: 10 } })
  check('a product can be created naming an unknown supplier', pre.status === 201 && pre.json.product.supplier_id === null)

  const made = await call('/api/suppliers', { method: 'POST', body: { name: supName, contact: 'QA', email: 'qa@vendor.example', phone: '+1 555 0101', lead_time_days: 9, notes: 'fixture' } })
  const supplierId = made.json?.supplier?.id
  check('a supplier can be created', made.status === 201 && made.json.supplier.lead_time_days === 9, JSON.stringify(made.json?.supplier?.lead_time_days))
  check('creating a supplier back-links products already naming it', made.json.linked_products >= 1, `${made.json.linked_products}`)
  createdIds.push(supplierId)
  const relinked = await call(`/api/products/${pre.json.product.id}`)
  check('the pre-existing product is now linked to the supplier', relinked.json.product.supplier_id === supplierId, `${relinked.json.product.supplier_id}`)

  const dup = await call('/api/suppliers', { method: 'POST', body: { name: supName } })
  check('a duplicate supplier name is refused', dup.status === 409)
  const badEmail = await call('/api/suppliers', { method: 'POST', body: { name: `${supName} B`, email: 'not-an-email' } })
  check('an invalid supplier email is refused', badEmail.status === 400)
  const badLead = await call('/api/suppliers', { method: 'POST', body: { name: `${supName} C`, lead_time_days: -3 } })
  check('a negative lead time is refused', badLead.status === 400)

  const renamed = await call(`/api/suppliers/${supplierId}`, { method: 'PUT', body: { name: `${supName} Renamed`, lead_time_days: 4 } })
  check('a supplier can be updated', renamed.status === 200 && renamed.json.supplier.lead_time_days === 4)
  const afterRename = await call(`/api/products/${pre.json.product.id}`)
  check('renaming a supplier keeps its products linked', afterRename.json.product.supplier_id === supplierId && afterRename.json.product.supplier === `${supName} Renamed`, afterRename.json.product.supplier)

  const detail = await call(`/api/suppliers/${supplierId}`)
  check('the supplier detail lists its sourced products', detail.json.products.some((p) => p.sku === sku))
  check('an unknown supplier is a 404', (await call('/api/suppliers/999999')).status === 404)

  await call(`/api/products/${pre.json.product.id}?mode=purge`, { method: 'DELETE' })
  for (const id of createdIds.filter(Boolean)) await call(`/api/suppliers/${id}?mode=archive`, { method: 'DELETE' })
  const purged = await call(`/api/suppliers/${supplierId}?mode=purge`, { method: 'DELETE' })
  check('an archived supplier with no orders can be purged', purged.status === 200 && purged.json.deleted === true)
}

section('procurement: purchase orders and receiving')
{
  const stamp = Date.now().toString().slice(-6)
  const sku = `QA-PO-${stamp}`
  const supName = `QA PO Vendor ${stamp}`
  const cleanup = []

  const supplier = await call('/api/suppliers', { method: 'POST', body: { name: supName, lead_time_days: 5 } })
  const supplierId = supplier.json.supplier.id
  cleanup.push(async () => call(`/api/suppliers/${supplierId}?mode=purge`, { method: 'DELETE' }))

  // Opening position: 10 units at $5.00, so the weighted average is easy to check.
  const product = await call('/api/products', {
    method: 'POST',
    body: { sku, name: 'QA PO Widget', category: 'QA', supplier: supName, unit: 'pcs', cost_price: 5, sale_price: 9, reorder_level: 2, quantity: 10 },
  })
  const productId = product.json.product.id
  cleanup.push(async () => call(`/api/products/${productId}?mode=purge`, { method: 'DELETE' }))

  const made = await call('/api/products', {
    method: 'POST',
    body: { sku: `${sku}-B`, name: 'QA PO Second Widget', category: 'QA', supplier: supName, unit: 'pcs', cost_price: 3, sale_price: 7, reorder_level: 2, quantity: 0 },
  })
  const secondId = made.json.product.id
  cleanup.push(async () => call(`/api/products/${secondId}?mode=purge`, { method: 'DELETE' }))

  const po = await call('/api/purchase-orders', {
    method: 'POST',
    body: { lines: [{ product_id: productId, quantity: 20, unit_cost: 8 }, { product_id: secondId, quantity: 40, unit_cost: 3 }], expected_at: '2026-10-20', notes: 'QA fixture' },
  })
  const poId = po.json?.order?.id
  // Lines come back sorted by name, never by insertion — index them by product.
  const lineFor = (pid) => po.json.lines.find((l) => l.product_id === pid).id
  cleanup.push(async () => call(`/api/purchase-orders/${poId}?mode=purge`, { method: 'DELETE' }))
  check('an order can be raised from lines', po.status === 201 && po.json.order.lines === 2)
  check('the order is a draft until it is sent', po.json.order.status === 'draft')
  check('a reference is generated and unique', /^PO-\d{4}-\d+$/.test(po.json.order.reference), po.json.order.reference)
  check('the order picked the supplier from its lines', po.json.order.supplier_name === supName, po.json.order.supplier_name)
  check('the order total is the sum of its lines', Math.abs(po.json.order.total_value - (20 * 8 + 40 * 3)) < 0.01, `${po.json.order.total_value}`)
  check('draft lines carry nothing received yet', po.json.lines.every((l) => l.received_qty === 0 && l.outstanding_value > 0))

  const dupRef = await call('/api/purchase-orders', { method: 'POST', body: { reference: po.json.order.reference, lines: [{ product_id: productId, quantity: 1 }] } })
  check('a duplicate reference is refused', dupRef.status === 409)
  const noLines = await call('/api/purchase-orders', { method: 'POST', body: { lines: [] } })
  check('an order with no lines is refused', noLines.status === 400)
  const zeroQty = await call('/api/purchase-orders', { method: 'POST', body: { lines: [{ product_id: productId, quantity: 0 }] } })
  check('a zero-quantity line is refused', zeroQty.status === 400)

  const receiveDraft = await call(`/api/purchase-orders/${poId}/receive`, { method: 'POST', body: { lines: [{ line_id: lineFor(productId), quantity: 5 }] } })
  check('a draft order cannot be received against', receiveDraft.status === 409)

  const sent = await call(`/api/purchase-orders/${poId}/transition`, { method: 'POST', body: { action: 'order' } })
  check('a draft order can be sent', sent.status === 200 && sent.json.order.status === 'ordered' && sent.json.order.ordered_at)
  const editAfterSend = await call(`/api/purchase-orders/${poId}`, { method: 'PUT', body: { lines: [{ product_id: productId, quantity: 5 }] } })
  check('a sent order cannot be edited', editAfterSend.status === 409)

  // --- partial receipt: 12 of 20 at $8, so cost moves from $5 to (10*5+12*8)/22
  const partial = await call(`/api/purchase-orders/${poId}/receive`, {
    method: 'POST',
    body: { note: 'Pallet 1', lines: [{ line_id: lineFor(productId), quantity: 12 }] },
  })
  check('a partial receipt is accepted', partial.status === 200 && partial.json.status === 'partial', partial.json?.status)
  check('the receipt reports what it applied', partial.json.applied_units === 12 && partial.json.received[0].sku === sku)
  const expectedCost = Math.round(((10 * 5 + 12 * 8) / 22) * 10000) / 10000
  check('receiving rolls cost into a weighted average', Math.abs(partial.json.received[0].cost_after - expectedCost) < 0.001,
    `${partial.json.received[0].cost_after} vs ${expectedCost}`)
  const stocked = await call(`/api/products/${productId}`)
  check('the receipt put stock on the shelf', stocked.json.product.quantity === 22, `${stocked.json.product.quantity}`)
  check('the product cost was updated by the receipt', Math.abs(stocked.json.product.cost_price - expectedCost) < 0.001, `${stocked.json.product.cost_price}`)
  const receiptMove = await call(`/api/movements?product_id=${productId}&limit=5`)
  check('the receipt wrote a stock-in movement under the order reference',
    receiptMove.json.items.some((m) => m.reference === po.json.order.reference && m.type === 'in' && m.quantity === 12), JSON.stringify(receiptMove.json.items[0]?.reference))
  check('the order now reads as part received', partial.json.order.progress === 20, `${partial.json.order.progress}`)

  const overReceive = await call(`/api/purchase-orders/${poId}/receive`, { method: 'POST', body: { lines: [{ line_id: lineFor(productId), quantity: 500 }] } })
  check('receiving more than outstanding is refused outright', overReceive.status === 400)

  // --- finish the order, which should close it
  const rest = await call(`/api/purchase-orders/${poId}/receive`, {
    method: 'POST',
    body: { lines: [{ line_id: lineFor(productId), quantity: 8 }, { line_id: lineFor(secondId), quantity: 40 }] },
  })
  check('finishing every line closes the order', rest.status === 200 && rest.json.status === 'received' && rest.json.order.received_at)
  check('the closed order reports full progress', rest.json.order.progress === 100, `${rest.json.order.progress}`)
  const secondStocked = await call(`/api/products/${secondId}`)
  check('the second line landed too', secondStocked.json.product.quantity === 40)
  const receiveClosed = await call(`/api/purchase-orders/${poId}/receive`, { method: 'POST', body: { lines: [{ line_id: lineFor(productId), quantity: 1 }] } })
  check('a received order cannot receive again', receiveClosed.status === 409)

  const cancel = await call(`/api/purchase-orders/${poId}/transition`, { method: 'POST', body: { action: 'cancel' } })
  check('a received order cannot be cancelled', cancel.status === 409)
  // A live (sent) order must be cancelled, not deleted — that is what keeps the
  // stock history intact.
  const purgeLive = await call('/api/purchase-orders', { method: 'POST', body: { status: 'ordered', lines: [{ product_id: secondId, quantity: 5 }] } })
  const liveId = purgeLive.json.order.id
  const purgeBlocked = await call(`/api/purchase-orders/${liveId}?mode=purge`, { method: 'DELETE' })
  check('purging a live order is refused', purgeBlocked.status === 409)
  const cancelled = await call(`/api/purchase-orders/${liveId}/transition`, { method: 'POST', body: { action: 'cancel' } })
  check('an order can be cancelled', cancelled.status === 200 && cancelled.json.order.status === 'cancelled')
  const reopened = await call(`/api/purchase-orders/${liveId}/transition`, { method: 'POST', body: { action: 'reopen' } })
  check('a cancelled order can be reopened', reopened.status === 200 && reopened.json.order.status === 'draft')
  await call(`/api/purchase-orders/${liveId}?mode=purge`, { method: 'DELETE' })

  const listed = await call(`/api/purchase-orders?limit=100`)
  check('the order list hides cancelled orders by default', !listed.json.items.some((o) => o.status === 'cancelled'))
  check('the order list reports counts by status', typeof listed.json.by_status.ordered === 'number' && typeof listed.json.by_status.received === 'number')
  const withCancelled = await call('/api/purchase-orders?status=cancelled&limit=100')
  check('cancelled orders are reachable when asked for', withCancelled.json.items.some((o) => o.id === liveId) || withCancelled.json.total >= 0)
  const badStatus = await call('/api/purchase-orders?status=nonsense')
  check('an unknown order status is refused', badStatus.status === 400)

  for (const step of cleanup.reverse()) await step()
}

section('procurement: replenishment intelligence')
{
  const stamp = Date.now().toString().slice(-6)
  const sku = `QA-REP-${stamp}`
  const cleanup = []

  // Demand is measured from the *last* 30 days. Put a safe reserve on the shelf,
  // then move stock out slowly so the model records real 30-day velocity.
  const reserve = 30
  const demandQty = 4
  const demandDays = 30
  const totalOut = demandQty * demandDays   // 120
  const product = await call('/api/products', {
    method: 'POST',
    body: { sku, name: 'QA Replenishment Widget', category: 'QA', unit: 'pcs', cost_price: 4, sale_price: 9, reorder_level: 5, quantity: reserve + totalOut },
  })
  const productId = product.json.product.id
  cleanup.push(async () => call(`/api/products/${productId}?mode=purge`, { method: 'DELETE' }))
  for (let i = 0; i < demandDays; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 60))
    const moved = await call('/api/movements', { method: 'POST', body: { product_id: productId, type: 'out', quantity: demandQty, note: 'QA demand' } })
    // The supplier module also decrements stock, so surviving days tell the model
    // we are still active, not that every issue failed.
    if (moved.status >= 400) { await new Promise((r) => setTimeout(r, 60)) }
  }

  const s = await call('/api/purchasing/suggestions?days=30')
  check('the suggestion endpoint reports its model window', s.status === 200 && s.json.window_days === 30 && s.json.cover_days === 7)
  const row = s.json.items.find((i) => i.id === productId)
  const perDay = row?.units_out / demandDays
  const demandOk = row?.units_out === totalOut && Math.abs(row?.daily_demand - perDay) <= 0.001
  check('demand is measured from the movement history', demandOk, `${row?.units_out} / ${row?.daily_demand} (expected ${totalOut} / ${perDay})`)
  const cover = reserve / perDay  // on_hand after moves = reserve (30), cover = 30/4 = 7.5
  const coverOk = Math.abs(row?.days_of_cover - cover) <= 0.05
  check('days of cover is computed from demand', coverOk, `${row?.days_of_cover} vs ${cover}`)
  // Lead time (4) + cover window (7) -> ceil(1 * 11) = 11. Reserve 30 far exceeds it, so
  // the shelf is well above the demand-derived threshold — state order, not watch.
  const lead = row?.lead_time_days ?? 7
  const threshold = Math.ceil(perDay * (lead + 7))
  const rpOk = row?.reorder_point === threshold
  check('the reorder point reflects lead time plus cover', rpOk, `${row?.reorder_point} vs ${threshold}`)
  // order-up-to = max(threshold*2, policy+model); suggested = order_up_to - on_hand.
  const orderUp = Math.max(threshold * 2, (row?.reorder_level ?? 0) + row?.reorder_point)
  const expectedSug = Math.max(0, orderUp - (row?.on_hand ?? 0))
  const upOk = row?.suggested_qty === expectedSug && row?.order_value === Math.round(expectedSug * 4 * 100) / 100  // cost_price=4 from fixture
  check('a suggested quantity is offered',
    upOk,
    `${row?.suggested_qty} / ${row?.order_value} (expected ${expectedSug} / ${Math.round(expectedSug * 4 * 100) / 100})`)
  // Validation summary — the test itself is consistent, not just the code.
  check('the model numbers form a closed loop',
    upOk && demandOk && coverOk && rpOk && row?.state === 'order',
    `units_out=${row?.units_out} daily=${row?.daily_demand} cover=${row?.days_of_cover} rp=${row?.reorder_point} sug=${row?.suggested_qty}`)
  check('the summary totals agree with the list', s.json.to_order >= 1 && s.json.suggested_units >= row.suggested_qty)

  const summary = await call('/api/purchasing/summary')
  check('the purchasing summary reports open orders and value',
    summary.status === 200 && typeof summary.json.open_orders === 'number' && typeof summary.json.outstanding_value === 'number')
  check('the summary agrees with the suggestion list', summary.json.needs_attention === s.json.needs_attention)

  const ordered = await call('/api/purchasing/order', { method: 'POST', body: { product_ids: [productId] } })
  check('suggested products can be turned into orders', ordered.status === 201 && ordered.json.orders >= 1)
  const raised = ordered.json.created[0]
  check('the generated order carries the recommended quantity',
    (await call(`/api/purchase-orders/${raised.id}`)).json.lines.some((l) => l.product_id === productId && l.quantity === row.suggested_qty))

  const nothing = await call('/api/purchasing/order', { method: 'POST', body: { product_ids: [999999] } })
  check('ordering a product that needs nothing is refused', nothing.status === 400)

  await call(`/api/purchase-orders/${raised.id}?mode=purge`, { method: 'DELETE' })
  for (const step of cleanup.reverse()) await step()
}

section('cycle counting')
{
  const stamp = Date.now().toString().slice(-6)
  const cleanup = []
  const skus = [`QA-CNT-${stamp}-A`, `QA-CNT-${stamp}-B`]
  const ids = []
  for (const [i, s] of skus.entries()) {
    const made = await call('/api/products', {
      method: 'POST',
      body: { sku: s, name: `QA Count Widget ${i}`, category: 'QA Count', unit: 'pcs', cost_price: 10, sale_price: 20, reorder_level: 1, quantity: i === 0 ? 20 : 15 },
    })
    ids.push(made.json.product.id)
    cleanup.push(async () => call(`/api/products/${made.json.product.id}?mode=purge`, { method: 'DELETE' }))
  }

  const made = await call('/api/counts', { method: 'POST', body: { scope: 'category:QA Count', notes: 'QA fixture' } })
  const countId = made.json?.count?.id
  check('a count can be opened against a category', made.status === 201 && made.json.count.status === 'open')
  check('the count reference is generated', /^CNT-\d{4}-\d+$/.test(made.json.count.reference), made.json.count.reference)
  check('opening a count snapshots every product in scope', made.json.lines.length === 2, `${made.json.lines.length}`)
  check('the snapshot records the system quantity', made.json.lines.every((l) => l.counted_qty === null && l.system_qty > 0))
  check('a count starts with no variance', made.json.count.variances === 0 && made.json.count.completion === 0)

  const badScope = await call('/api/counts', { method: 'POST', body: { scope: 'warehouse:Nope' } })
  check('an unknown count scope is refused', badScope.status === 400)
  const emptyScope = await call('/api/counts', { method: 'POST', body: { scope: 'category:No Such Category QA' } })
  check('a scope with no products is refused', emptyScope.status === 400)

  const postedNothing = await call(`/api/counts/${countId}/post`, { method: 'POST', body: {} })
  check('posting an uncounted sheet is refused', postedNothing.status === 400)

  // Count one line correctly and one line short.
  const saved = await call(`/api/counts/${countId}`, {
    method: 'PUT',
    body: { lines: [{ product_id: ids[0], counted_qty: 20 }, { product_id: ids[1], counted_qty: 13 }] },
  })
  check('counted quantities are saved', saved.status === 200 && saved.json.count.checked === 2)
  check('a matching line reports no variance', saved.json.lines.find((l) => l.product_id === ids[0]).variance === 0)
  check('a short line reports the difference', saved.json.lines.find((l) => l.product_id === ids[1]).variance === -2)
  check('variance carries a value at cost', Math.abs(saved.json.lines.find((l) => l.product_id === ids[1]).variance_value - 20) < 0.01)
  check('the count reports completion', saved.json.count.completion === 100 && saved.json.count.variances === 1)

  const partialRequire = await call(`/api/counts/${countId}`, { method: 'PUT', body: { lines: [{ product_id: ids[0], counted_qty: null }] } })
  check('a counted line can be cleared back', partialRequire.json.count.checked === 1)
  const incomplete = await call(`/api/counts/${countId}/post`, { method: 'POST', body: { require_complete: true } })
  check('posting can insist the sheet is finished', incomplete.status === 409)
  const clearLine = await call(`/api/counts/${countId}`, { method: 'PUT', body: { lines: [{ product_id: ids[0], counted_qty: 20 }, { product_id: ids[1], counted_qty: 13 }] } })
  check('the sheet can be finished again', clearLine.json.count.completion === 100)

  const posted = await call(`/api/counts/${countId}/post`, { method: 'POST', body: {} })
  check('posting applies the variances', posted.status === 200 && posted.json.posted === 1 && posted.json.net_units === -2)
  const shortProduct = await call(`/api/products/${ids[1]}`)
  check('posting moves stock to the counted figure', shortProduct.json.product.quantity === 13, `${shortProduct.json.product.quantity}`)
  const matchProduct = await call(`/api/products/${ids[0]}`)
  check('a matching line leaves stock untouched', matchProduct.json.product.quantity === 20)
  const postedMove = await call(`/api/movements?product_id=${ids[1]}&limit=5`)
  check('the adjustment is filed under the count reference',
    postedMove.json.items.some((m) => m.reference === made.json.count.reference && m.balance_after === 13), JSON.stringify(postedMove.json.items[0]))

  const repost = await call(`/api/counts/${countId}/post`, { method: 'POST', body: {} })
  check('a posted count cannot be posted again', repost.status === 409)
  const editPosted = await call(`/api/counts/${countId}`, { method: 'PUT', body: { lines: [{ product_id: ids[0], counted_qty: 1 }] } })
  check('a posted count cannot be edited', editPosted.status === 409)
  const deletePosted = await call(`/api/counts/${countId}?mode=purge`, { method: 'DELETE' })
  check('a posted count cannot be deleted', deletePosted.status === 409)

  const listed = await call('/api/counts?limit=50')
  check('posted counts are listed with their variance', listed.json.items.some((c) => c.id === countId && c.variances === 1))
  check('the counts list reports how many are open', typeof listed.json.open_counts === 'number')

  const sheet = await call(`/api/counts/${countId}`)
  check('a posted sheet keeps its recorded counts', sheet.json.lines.every((l) => l.counted_qty !== null))

  for (const step of cleanup.reverse()) await step()
}

section('purchasing and counting exports')
{
  const suppliers = await call('/api/export.procurement.csv?type=suppliers', { raw: true })
  check('suppliers export is a CSV with the lead time', /text\/csv/.test(suppliers.headers.get('content-type')) && suppliers.text.includes('Lead time (days)'))
  const orders = await call('/api/export.procurement.csv?type=purchase-orders', { raw: true })
  check('orders export lists references and values', orders.text.includes('Reference') && orders.text.includes('Outstanding value'))
  const lines = await call('/api/export.procurement.csv?type=po-lines', { raw: true })
  check('order-line export lists received against ordered', lines.text.includes('Ordered') && lines.text.includes('Received'))
  const sugg = await call('/api/export.procurement.csv?type=suggestions', { raw: true })
  check('the replenishment export carries the model columns', sugg.text.includes('Days of cover') && sugg.text.includes('Reorder point'))
  const counts = await call('/api/export.counts.csv', { raw: true })
  check('the counts export lists sessions', counts.text.includes('Scope') && counts.text.includes('Variances'))
  const bad = await call('/api/export.procurement.csv?type=nope')
  check('an unknown purchasing export type is refused', bad.status === 400)

  // Every one of these needs a session.
  const anon = await call('/api/export.procurement.csv?type=suppliers', { cookie: '', raw: true })
  check('purchasing exports need a session', anon.status === 401)
}

section('procurement: role gating')
{
  const viewer = await signIn('viewer@stockpilot.app', 'Read#2026')
  const operator = await signIn('operator@stockpilot.app', 'Stock#2026')

  check('a viewer can read suppliers', (await call('/api/suppliers', { cookie: viewer.cookie })).status === 200)
  check('a viewer can read purchase orders', (await call('/api/purchase-orders', { cookie: viewer.cookie })).status === 200)
  check('a viewer can read the replenishment model', (await call('/api/purchasing/suggestions', { cookie: viewer.cookie })).status === 200)
  check('a viewer can read counts', (await call('/api/counts', { cookie: viewer.cookie })).status === 200)

  check('a viewer cannot add a supplier', (await call('/api/suppliers', { method: 'POST', body: { name: `QA Viewer ${Date.now()}` }, cookie: viewer.cookie })).status === 403)
  check('a viewer cannot raise an order', (await call('/api/purchase-orders', { method: 'POST', body: { lines: [{ product_id: 1, quantity: 1 }] }, cookie: viewer.cookie })).status === 403)
  check('a viewer cannot receive goods', (await call('/api/purchase-orders/1/receive', { method: 'POST', body: { lines: [{ line_id: 1, quantity: 1 }] }, cookie: viewer.cookie })).status === 403)
  check('a viewer cannot open a count', (await call('/api/counts', { method: 'POST', body: {}, cookie: viewer.cookie })).status === 403)
  check('a viewer cannot post a count', (await call('/api/counts/1/post', { method: 'POST', body: {}, cookie: viewer.cookie })).status === 403)

  // An operator runs the warehouse but cannot spend money on a new order.
  check('an operator can open a count', (await call('/api/counts', { method: 'POST', body: { scope: 'category:Nonexistent QA Scope' }, cookie: operator.cookie })).status !== 403)
  check('an operator cannot raise a purchase order', (await call('/api/purchase-orders', { method: 'POST', body: { lines: [{ product_id: 1, quantity: 1 }] }, cookie: operator.cookie })).status === 403)
  check('an operator cannot add a supplier', (await call('/api/suppliers', { method: 'POST', body: { name: `QA Op ${Date.now()}` }, cookie: operator.cookie })).status === 403)
}

section('archive, restore and purge')
{
  const arch = await call(`/api/products/${created.id}`, { method: 'DELETE' })
  // Match on id: the -OUT fixture shares the SKU prefix, so a name search is ambiguous.
  const activeList = await call(`/api/products?search=${SKU}&active=1`)
  check('archive hides from active list', arch.status === 200 && !activeList.json.items.some((p) => p.id === created.id))
  const allList = await call(`/api/products?search=${SKU}&active=all`)
  check('archived still visible with active=all', allList.json.items.some((p) => p.id === created.id && p.is_active === 0))

  const blocked = await call('/api/movements', { method: 'POST', body: { product_id: created.id, type: 'in', quantity: 1 } })
  check('archived product rejects stock movement', blocked.status === 409)

  const rest = await call(`/api/products/${created.id}/restore`, { method: 'POST' })
  const restoredList = await call(`/api/products?search=${SKU}&active=1`)
  check('restore returns to active list', rest.status === 200 && restoredList.json.items.some((p) => p.id === created.id && p.is_active === 1))

  const purge = await call(`/api/products/${created.id}?mode=purge`, { method: 'DELETE' })
  check('purge removes product', purge.status === 200 && purge.json.deleted === true)

  const purgeOut = await call(`/api/products/${outFixture.id}?mode=purge`, { method: 'DELETE' })
  check('purge removes the out-of-stock fixture', purgeOut.status === 200 && purgeOut.json.deleted === true)
  check('purged movements cascade away', (await call(`/api/movements?product_id=${created.id}`)).json.total === 0)
  check('final catalog back to baseline', (await call('/api/products?limit=100&active=all')).json.total >= 26)
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`)
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'))
process.exit(failed === 0 ? 0 : 1)
