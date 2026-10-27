// Renders the real React app in jsdom against a live Worker API and asserts
// that each screen paints live data. Run with `npm run dev:worker` already up.
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { existsSync, readFileSync } from 'node:fs'

const API = process.env.API_BASE || 'http://127.0.0.1:8787'

let passed = 0
let failed = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---- jsdom environment -----------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3000/',
  pretendToBeVisual: true,
})
const { window } = dom
const expose = (key, value) => Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
expose('window', window)
expose('document', window.document)
expose('navigator', window.navigator)
expose('HTMLElement', window.HTMLElement)
expose('HTMLInputElement', window.HTMLInputElement)
expose('Node', window.Node)
expose('Event', window.Event)
expose('MouseEvent', window.MouseEvent)
// The photo intake reads a picked File with FileReader and (where a canvas
// exists) decodes it with an Image; a browser has both as globals.
expose('FileReader', window.FileReader)
expose('File', window.File)
expose('Image', window.Image)
expose('getComputedStyle', window.getComputedStyle)
// pretendToBeVisual gives jsdom an rAF clock; expose it as the browser global.
expose('requestAnimationFrame', window.requestAnimationFrame.bind(window))
expose('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
expose('IS_REACT_ACT_ENVIRONMENT', false)
window.confirm = () => true

// jsdom ships no matchMedia; emulate it so the motion system is exercised, and
// let REDUCED_MOTION=1 run the whole suite down the reduced-motion path.
const REDUCED = process.env.REDUCED_MOTION === '1'
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query) => ({
    media: query,
    matches: REDUCED && query.includes('prefers-reduced-motion'),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
})

/* ---- sessions ------------------------------------------------------------
   Every endpoint now needs a session cookie, so the harness keeps two:
   ADMIN_COOKIE for the fixtures and API comparisons the suite makes directly,
   and `cookieJar` for the app under test — which starts empty so the login
   screen is exercised for real and fills in from the response headers. */
const realFetch = globalThis.fetch /* raw, cookie-free */

const readCookie = (res) => {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const m = /sp_session=([^;]*)/.exec(raw)
    if (m) return m[1] ? `sp_session=${m[1]}` : ''
  }
  return null
}

async function signInDirect(email, password) {
  const res = await realFetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`harness sign-in failed: ${res.status} ${await res.text()}`)
  return readCookie(res)
}
const ADMIN_COOKIE = await signInDirect('admin@stockpilot.app', 'Pilot#2026')

/** Direct API access as the harness administrator. */
const apiCall = (url, init = {}) => realFetch(
  String(url).startsWith('http') ? String(url) : `${API}${url}`,
  { ...init, headers: { ...(init.headers ?? {}), cookie: ADMIN_COOKIE } },
)

let cookieJar = ''
const setCookieJar = (value) => { cookieJar = value }

globalThis.fetch = async (url, init = {}) => {
  const res = await realFetch(new URL(String(url), API).toString(), {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookieJar ? { cookie: cookieJar } : {}) },
  })
  const next = readCookie(res)
  if (next !== null) cookieJar = next
  return res
}
window.fetch = globalThis.fetch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// The app animates on real animation frames, so interactions are driven with
// real timers exactly as a browser would; no act() wrapper is involved.
const act = async (fn) => { const out = fn(); if (out && typeof out.then === 'function') await out; return out }
const text = () => window.document.getElementById('root').textContent
const text_ = (el) => el.textContent
// Counters animate, so poll until the value stops moving rather than trusting a
// fixed sleep — otherwise a slow first API response reads a half-finished count.
const settleValue = async (read, { tries = 60, gap = 100, stable = 3 } = {}) => {
  let last = null; let steady = 0
  for (let i = 0; i < tries; i += 1) {
    await act(async () => { await sleep(gap) })
    const value = read()
    if (value === last) { steady += 1; if (steady >= stable) return value } else { steady = 0 }
    last = value
  }
  return last
}
const $$ = (sel) => [...window.document.querySelectorAll(sel)]

/* A run that dies mid-flight (worker restart, Ctrl-C) can leave its fixtures
   behind, and a zero-value fixture is enough to break a downstream chart. Sweep
   anything still carrying the harness SKU prefix before seeding a fresh set. */
const stale = await apiCall(`${API}/api/products?search=UITEST-&active=all&limit=100`).then((r) => r.json())
for (const leftover of stale.items ?? []) {
  await apiCall(`${API}/api/products/${leftover.id}?mode=purge`, { method: 'DELETE' })
  console.log(`  swept stale fixture ${leftover.sku}`)
}

// Guarantee an out-of-stock and a low-stock product exist for the alert
// assertions, then remove them again — the suite must not depend on (or
// damage) whatever demo data is in the database.
const STAMP = Date.now().toString().slice(-6)
const FIXTURES = [
  { sku: `UITEST-${STAMP}-LOW`, name: 'UI Fixture Low Stock Widget', category: 'QA Fixtures', cost_price: 5, sale_price: 9, reorder_level: 25, quantity: 4 },
  { sku: `UITEST-${STAMP}-OUT`, name: 'UI Fixture Out Of Stock Widget', category: 'QA Fixtures', cost_price: 7, sale_price: 13, reorder_level: 15, quantity: 0 },
]
const fixtureIds = []
for (const fixture of FIXTURES) {
  const res = await apiCall(`${API}/api/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unit: 'pcs', supplier: 'QA Harness', location: 'Test Bay', ...fixture }),
  })
  if (!res.ok) throw new Error(`fixture setup failed for ${fixture.sku}: ${res.status} ${await res.text()}`)
  fixtureIds.push((await res.json()).product.id)
}
console.log(`seeded ${fixtureIds.length} UI fixtures (${FIXTURES.map((f) => f.sku).join(', ')})`)

const cleanupFixtures = async () => {
  for (const id of fixtureIds) {
    const res = await apiCall(`${API}/api/products/${id}?mode=purge`, { method: 'DELETE' })
    if (!res.ok) console.log(`  WARN fixture ${id} not cleaned up: ${res.status}`)
  }
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
// react / react-dom are externalised by Vite's SSR loader, so import them from
// Node directly (after the DOM globals above are in place) to guarantee the
// app and this script share one React instance.
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: App } = await vite.ssrLoadModule('/src/App.jsx')

const root = createRoot(window.document.getElementById('root'))
const settle = async (ms = 1500) => {
  await act(async () => { await sleep(ms) })
}
const goTo = async (hash) => {
  await act(async () => {
    window.location.hash = hash
    window.dispatchEvent(new window.Event('hashchange'))
    await sleep(50)
  })
  await settle()
}

try {
console.log('\nauthentication')
await act(async () => { root.render(React.createElement(App)) })
await settle(1200)
{
  // A helper that writes through the native setter, which is how React's own
  // value tracker notices a change coming from outside a real browser.
  const setValue = async (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    await act(async () => { await sleep(30) })
  }
  const submitLogin = async () => {
    window.document.querySelector('.login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await settle(900)
  }
  const click = async (el, wait = 300) => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(wait)
  }

  check('unauthenticated visit lands on the login screen', $$('#login-screen').length === 1 && $$('.login-card').length === 1)
  check('the console shell is not rendered while signed out', $$('.app').length === 0)
  check('login screen carries the brand lockup', $$('.login-card [data-testid="brand-logo"]').length === 1)
  check('login screen keeps the cyber watermark', $$('[data-testid="site-watermark"]').length === 1)
  check('login form asks for email and password', $$('.login-input input[name="email"]').length === 1 && $$('.login-input input[name="password"]').length === 1)
  check('password field is masked by default', $$('.login-input input[name="password"]')[0].type === 'password')
  const revealBtn = window.document.querySelector('.login-reveal')
  await click(revealBtn, 60)
  check('show/hide reveals the password field', $$('.login-input input[name="password"]')[0].type === 'text')
  await click(window.document.querySelector('.login-reveal'), 60)
  check('remember-me is offered', $$('.login-row input[type="checkbox"]').length === 1)

  // ---- the credentials readout below the form --------------------------
  const demoDoc = await apiCall(`${API}/api/auth/demo`).then((r) => r.json())
  const rows = $$('.demo-row')
  check('demo credentials are listed below the login form', rows.length === demoDoc.accounts.length && rows.length >= 3, `${rows.length} rows vs ${demoDoc.accounts.length}`)
  check('demo list prints every email', demoDoc.accounts.every((a) => $$('.demo-email').some((el) => el.textContent === a.email)))
  check('the seeded passwords start masked', rows.every((r) => r.querySelector('.demo-password').textContent.includes('•')))
  for (const row of rows) await click(row.querySelector('.demo-reveal'), 60)
  check('revealing a row prints the exact seeded password', demoDoc.accounts.every((a) => {
    const row = rows.find((r) => r.querySelector('.demo-email').textContent === a.email)
    return row.querySelector('.demo-password').textContent === a.password
  }), rows.map((r) => r.querySelector('.demo-password').textContent).join(' | '))
  check('each row is labelled with its role', $$('.demo-badge').map((b) => b.textContent).join(',') === demoDoc.accounts.map((a) => ({ admin: 'Admin', operator: 'Operator', viewer: 'Viewer' }[a.role])).join(','), $$('.demo-badge').map((b) => b.textContent).join(','))
  check('the admin row is the highlighted one', $$('.demo-role-admin').length === 1)

  // ---- wrong password --------------------------------------------------
  await setValue($$('.login-input input[name="email"]')[0], 'admin@stockpilot.app')
  await setValue($$('.login-input input[name="password"]')[0], 'definitely-wrong')
  await submitLogin()
  check('wrong password keeps us on the login screen', $$('#login-screen').length === 1 && $$('.app').length === 0)
  check('wrong password shows the API message', /incorrect/i.test(window.document.querySelector('.login-error')?.textContent ?? ''), $$('.login-error')[0]?.textContent?.slice(0, 80))
  check('wrong password reports remaining attempts', /attempt/i.test(window.document.querySelector('.login-error')?.textContent ?? ''))
  check('a refused sign-in issues no session cookie', cookieJar === '')

  // ---- click-to-fill from the credentials panel, then sign in ----------
  const adminRow = $$('.demo-row').find((r) => r.classList.contains('demo-role-admin'))
  await click(adminRow.querySelector('.demo-fill'), 120)
  check('tapping a credential row fills the email field', $$('.login-input input[name="email"]')[0].value === 'admin@stockpilot.app', $$('.login-input input[name="email"]')[0].value)
  check('tapping a credential row fills the password field', $$('.login-input input[name="password"]')[0].value.length > 0)
  await submitLogin()
  await settle(1600)
  check('signing in swaps the login screen for the console', $$('#login-screen').length === 0 && $$('.app').length === 1)
  check('sign-in stored a session cookie for the app', cookieJar.startsWith('sp_session='), cookieJar.slice(0, 24))
  check('the sidebar shows who is signed in', /Avery Stone/.test(window.document.querySelector('.session-card')?.textContent ?? '') && /Admin/.test(window.document.querySelector('.session-role')?.textContent ?? ''))
  check('an admin sees the access-control section', $$('.nav-item').some((n) => n.textContent.includes('Access control')))
}

console.log('\ndashboard')
await settle(1200)
{
  const body = text()
  check('sidebar renders all five sections', ['Dashboard', 'Products', 'Stock movements', 'Low-stock alerts', 'Reports'].every((s) => body.includes(s)))
  check('connection status is live', body.includes('Live data'), body.slice(0, 120))
  check('dashboard page title carries the logo mark', $$('.page-head .head-mark').length === 1)
  check('dashboard health strip shows the gauge and four KPI rings', $$('.gauge').length === 1 && $$('.ring-stat').length === 4, `${$$('.gauge').length} gauges / ${$$('.ring-stat').length} rings`)
  check('dashboard rings animate to non-zero sweeps', $$('.ring-value').every((c) => Number(c.getAttribute('stroke-dashoffset')) < Number(c.getAttribute('stroke-dasharray'))))
  check('KPI: stock value card', /Stock value \(cost\)/.test(body) && /\$\d/.test(body))
  check('KPI: units on hand card', body.includes('Units on hand'))
  check('KPI: low stock card', body.includes('Low stock'))
  check('movement chart rendered as SVG bars', $$('svg.chart rect.bar').length > 10, `${$$('svg.chart rect.bar').length} bars`)
  check('KPI cards render animated sparklines', $$('.stat-spark svg.spark path.spark-line').length >= 2, `${$$('.stat-spark svg.spark path.spark-line').length} sparklines`)
  const kpi = await apiCall(`${API}/api/dashboard?days=14`).then((r) => r.json())
  const asMoney = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(kpi.kpis.stock_value)
  const counted = await settleValue(() => $$('.stat-value')[0].textContent)
  check('KPI counter counts up to the exact API stock value', counted === asMoney, `${counted} vs ${asMoney}`)

  const donut = $$('svg.donut-svg circle.donut-seg')
  check('category donut rendered with one arc per category', donut.length >= 4, `${donut.length} arcs`)
  const arcs = donut.map((c) => Number(String(c.getAttribute('stroke-dasharray')).split(' ')[0]))
  check('donut arcs have non-zero sweep after animating in', arcs.every((a) => a > 0), arcs.map((a) => a.toFixed(1)).join(','))
  check('donut legend lists every category', $$('.donut-legend li').length === donut.length)
  check('donut centre shows the stock value total', /\$[\d,]+/.test($$('.donut-center strong')[0].textContent))

  check('top movers rank bars rendered', $$('.rank-fill').length >= 8, `${$$('.rank-fill').length}`)
  check('rank bars animated out to their widths', $$('.rank-fill').every((el) => parseFloat(el.style.width) > 0))
  check('recent activity table populated', $$('table.table tbody tr').length >= 5, `${$$('table.table tbody tr').length} rows`)
  check('low-stock alert list populated', $$('.alert-list li').length >= 1, `${$$('.alert-list li').length}`)
  check('dashboard alert list shows artwork', $$('.alert-list li').every((li) => li.querySelector('.product-art')))
  check('recent activity rows show artwork', $$('table.table tbody tr').every((r) => r.querySelector('.cell-product .product-art') || r.querySelectorAll('td').length < 4))
  const badges = $$('.badge-low').length + $$('.badge-out').length
  check('alert severity badges rendered', badges >= 1)
  check('nav badge shows alert count', $$('.nav-badge').length === 1)

  const alerts = await apiCall(`${API}/api/alerts`).then((r) => r.json())
  const value = alerts.summary.total
  check('nav badge matches API alert count', $$('.nav-badge')[0].textContent.replace(/,/g, '') === String(value), `${$$('.nav-badge')[0].textContent} vs ${value}`)

  // Chart type switcher: bars -> area -> line -> bars.
  const areaBtn = $$('.segmented button').find((b) => b.textContent === 'Area')
  await act(async () => { areaBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(600)
  check('switching to the area chart removes bars', $$('svg.chart rect.bar').length === 0)
  check('area chart draws two filled series + two lines', $$('svg.chart-chart path, svg.chart path').length >= 4, `${$$('svg.chart path').length} paths`)
  check('area chart adds data nodes', $$('svg.chart circle.chart-node').length > 10, `${$$('svg.chart circle.chart-node').length} nodes`)

  const lineBtn = $$('.segmented button').find((b) => b.textContent === 'Line')
  await act(async () => { lineBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(600)
  check('switching to the line chart keeps drawing series', $$('svg.chart path').length >= 4)

  const barsBtn = $$('.segmented button').find((b) => b.textContent === 'Bars')
  await act(async () => { barsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(700)
  check('switching back to bars restores the bar layer', $$('svg.chart rect.bar').length > 10, `${$$('svg.chart rect.bar').length} bars`)

  // Theme toggle.
  const toggle = window.document.querySelector('.theme-toggle')
  const before = window.document.documentElement.dataset.theme
  await act(async () => { toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  const after = window.document.documentElement.dataset.theme
  check('theme toggle flips the document theme', before !== after && ['dark', 'light'].includes(after), `${before} -> ${after}`)
  check('theme choice is persisted', window.localStorage.getItem('stockpilot:theme') === after)
  check('toggle reflects the active theme', window.document.querySelector('.theme-toggle').dataset.theme === after)
  await act(async () => { toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  check('theme toggle flips back', window.document.documentElement.dataset.theme === before)
  // PDF report action: the link must carry the range the screen is showing.
  const pdfBtn = window.document.querySelector('.pdf-btn')
  check('dashboard offers a PDF report download', pdfBtn && /Download|PDF report/.test(pdfBtn.textContent) && pdfBtn.classList.contains('btn-primary'))
  const hrefOf = () => window.document.querySelector('.pdf-btn').getAttribute('href')
  const fourteen = hrefOf()
  check('PDF link points at the report endpoint', /^\/api\/report\.pdf\?/.test(fourteen), fourteen)
  check('PDF link is a download', window.document.querySelector('.pdf-btn').hasAttribute('download'))
  check('PDF link carries the current 14-day window', (() => {
    const p = new URLSearchParams(fourteen.split('?')[1])
    const days = Math.round((Date.parse(p.get('to')) - Date.parse(p.get('from'))) / 86400000) + 1
    return days === 14
  })(), fourteen)
  const thirty = $$('.segmented button').find((b) => b.textContent === '30 days')
  await act(async () => { thirty.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(400)
  check('changing the range rewrites the PDF link', (() => {
    const p = new URLSearchParams(hrefOf().split('?')[1])
    return Math.round((Date.parse(p.get('to')) - Date.parse(p.get('from'))) / 86400000) + 1 === 30
  })(), hrefOf())
  const backTo14 = $$('.segmented button').find((b) => b.textContent === '14 days' || b.textContent === '14 days ')
  if (backTo14) await act(async () => { backTo14.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
}

console.log('\nbrand')
const art = await import('../src/brand-art.js')
{
  // --- the logo lockup -----------------------------------------------------
  const mark = $$('.brand svg.logo-mark')
  check('sidebar renders the logo mark', mark.length === 1)
  check('mark prints on its light plate', Boolean(mark[0]?.querySelector('rect.logo-chip')))
  check('mark carries every part of the artwork', mark[0]?.querySelectorAll('path').length >= 20, `${mark[0]?.querySelectorAll('path').length} paths`)
  check('two-tone wordmark reads STOCK + PILOT', $$('.logo-word-a')[0]?.textContent === 'STOCK' && $$('.logo-word-b')[0]?.textContent === 'PILOT')
  check('tagline line rendered under the wordmark', $$('.logo-tagline')[0]?.textContent === 'SMART INVENTORY SYSTEM')
  check('brand mark is named for assistive tech', mark[0]?.getAttribute('aria-label') === 'StockPilot')
  check('decorative marks are hidden, labelled ones announce the brand', $$('svg.logo-mark[aria-hidden="true"]').length >= 2 && $$('svg.logo-mark[aria-label="StockPilot"]').length >= 2, `${$$('svg.logo-mark[aria-hidden="true"]').length} hidden / ${$$('svg.logo-mark[aria-label]').length} labelled`)

  // --- the cyber watermark -------------------------------------------------
  const wm = $$('.site-watermark')
  check('exactly one watermark layer exists', wm.length === 1, `${wm.length} found`)
  check('watermark is decorative and non-interactive in the DOM', wm[0]?.getAttribute('aria-hidden') === 'true' && $$('.site-watermark .cyber-grid').length === 1)
  const emblem = $$('.site-watermark .cyber-emblem')
  check('watermark holds a single centred emblem', emblem.length === 1)
  const cyberMark = $$('.site-watermark .cyber-mark')
  check('watermark emblem is the outline of the logo', cyberMark.length === 1 && cyberMark[0].querySelectorAll('path').length === art.wireframeLayers().length)
  check('watermark emblem shares the logo geometry', cyberMark[0]?.querySelector('path').getAttribute('d') === art.wireframeLayers()[0].d)
  check('watermark emblem is drawn in currentColor', cyberMark[0]?.querySelector('path').getAttribute('stroke') === 'currentColor')
  check('HUD furniture: ring, four brackets, readout, scanline', $$('.site-watermark .cyber-ring').length === 1 && $$('.site-watermark .cyber-bracket').length === 4 && $$('.site-watermark .cyber-label').length === 1 && $$('.site-watermark .cyber-scan').length === 1)
  check('watermark readout names the brand + system', $$('.site-watermark .cyber-label')[0]?.textContent === 'STOCKPILOT // SMART INVENTORY SYSTEM')
  check('watermark has one glow plate behind the emblem', $$('.site-watermark .cyber-glow').length === 1)

  // --- footer / credits ----------------------------------------------------
  check('sidebar footer carries the brand credit', $$('.brand-credit svg.logo-mark').length === 1)
  check('page footer shows the lockup and product line', $$('.app-foot svg.logo-mark').length === 1 && text().includes('Smart Inventory Management System'))
  check('footer links the downloadable brand asset', $$('.app-foot a[download]').some((a) => a.getAttribute('href') === '/logo.svg'))

  // --- public/ is generated from src/brand-art.js ---------------------------
  const readPublic = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').trim()
  const generated = {
    'logo.svg': art.markSvg({ size: 512, chip: true }),
    'logo-mark.svg': art.markSvg({ size: 128 }),
    'favicon.svg': art.markSvg({ size: 64, chip: true }),
    'logo-full.svg': art.fullLogoSvg({ height: 128 }),
  }
  for (const [file, svg] of Object.entries(generated)) {
    check(`public/${file} matches src/brand-art.js`, readPublic(file) === svg)
  }
  check('public/app-icon.svg is the plate-filled mark', readPublic('app-icon.svg').includes(art.BRAND.colors.chip))
  check('public/mark-wireframe.svg is the watermark emblem', readPublic('mark-wireframe.svg').includes(art.wireframeLayers()[0].d))
  const icons = ['favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']
  check('raster app icons are present', icons.every((f) => existsSync(new URL(`../public/${f}`, import.meta.url))))
  check('committed PNG icons are real PNGs', icons.every((f) => readFileSync(new URL(`../public/${f}`, import.meta.url)).subarray(1, 4).toString() === 'PNG'))
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  check('index.html links the brand icons + manifest', ['/favicon.svg', '/apple-touch-icon.png', '/manifest.webmanifest'].every((v) => html.includes(v)))

  // --- CSS contract (jsdom has no CSS engine) ------------------------------
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const wmRule = (css.match(/\n\.site-watermark \{[^}]*\}/s) || [''])[0]
  check('watermark rule centres one fixed layer under modals', /position: fixed/.test(wmRule) && /inset: 0/.test(wmRule) && /place-items: center/.test(wmRule) && /pointer-events: none/.test(wmRule) && /z-index: 2/.test(wmRule))
  check('watermark ink + strength come from theme variables', /color: var\(--cyber-ink\)/.test(wmRule) && /opacity: var\(--cyber-opacity\)/.test(wmRule) && /--cyber-ink: #4c8df6/.test(css) && /--cyber-ink: #1e58ce/.test(css))
  check('watermark glows on dark and prints on light', /mix-blend-mode: screen/.test(wmRule) && /:root\[data-theme='light'\] \.site-watermark \{ mix-blend-mode: multiply/.test(css))
  check('watermark grid + scanline are animated', /animation: cyber-spin/.test(css) && /animation: cyber-scan/.test(css) && /@keyframes cyber-scan/.test(css))
  check('watermark motion is disabled under reduced motion', /prefers-reduced-motion[^{]*\{[^}]*\.cyber-ring, \.cyber-scan/s.test(css))
  check('watermark is suppressed when printing', /@media print[\s\S]*\.site-watermark, \.sidebar-ghost, \.toasts \{ display: none !important; \}/.test(css))

  // --- the shipped Worker serves the brand ---------------------------------
  const fav = await apiCall(`${API}/favicon.svg`)
  check('worker serves the favicon SVG', fav.status === 200 && String(fav.headers.get('content-type')).includes('image/svg+xml'), `${fav.status} ${fav.headers.get('content-type')}`)
  const icon = await apiCall(`${API}/apple-touch-icon.png`)
  check('worker serves the app icon PNG', icon.status === 200 && String(icon.headers.get('content-type')).includes('image/png'), `${icon.status} ${icon.headers.get('content-type')}`)
  const manifest = await apiCall(`${API}/manifest.webmanifest`)
  check('worker serves the web app manifest', manifest.status === 200 && (await manifest.json()).short_name === 'StockPilot')
}

await goTo('#/products')
{
  check('products page title carries the logo mark', $$('.page-head .head-mark').length === 1)
  check('product table rendered', $$('table.table tbody tr').length >= 10, `${$$('table.table tbody tr').length} rows`)
  check('product names from API shown', text().includes('Wireless Mouse Pro') || text().includes('A4 Paper Ream'))
  check('pagination controls rendered', $$('.pager').length === 1 && text().includes('Next'))
  check('category filter populated from API', $$('select option').some((o) => o.textContent.includes('Electronics')))
  check('CSV export link present', $$('a.btn').some((a) => a.getAttribute('href')?.includes('/api/export.csv')))

  // ---- product artwork --------------------------------------------------
  const artInRows = $$('table.table tbody tr')
  check('every product row carries artwork', artInRows.length > 0 && artInRows.every((r) => r.querySelector('.cell-product .product-art') || r.querySelector('.cell-product .product-photo')), `${artInRows.filter((r) => r.querySelector('.cell-product .product-art') || r.querySelector('.cell-product .product-photo')).length}/${artInRows.length}`)
  check('artwork is labelled with its category family', (() => { const arts=$$('.cell-product .product-art'); const first=arts.find(a => a.dataset && a.dataset.art); return first && first.dataset.art.length > 0 && first.dataset.tone.startsWith('#') })())
  check('artwork draws a category glyph', $$('.cell-product .product-art path').length >= artInRows.length)
  check('the product API carries an image field', (await apiCall(`${API}/api/products?limit=1`).then((r) => r.json())).items[0].has_photo !== undefined)

  const galleryBtn = $$('.view-switch button').find((b) => b.textContent === 'Gallery')
  await act(async () => { galleryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(800)
  const apiTotal = (await apiCall(`${API}/api/products?limit=100&active=1`).then((r) => r.json())).total
  check('gallery view renders a card per product on the page', $$('.product-card').length === 12, `${$$('.product-card').length} cards`)
  check('gallery cards show artwork, name, facts and status', $$('.product-card').every((c) => (c.querySelector('.product-art') || c.querySelector('.product-photo')) && c.querySelector('.product-card-name') && c.querySelector('.badge')))
  check('gallery explains the artwork source', $$('.product-card').every((c) => c.querySelector('.product-card-tags').textContent.trim().length > 0))
  check('gallery agrees with the API on the filtered total', apiTotal >= 12, `${apiTotal} active products`)
  const tableBtn = $$('.view-switch button').find((b) => b.textContent === 'Table')
  await act(async () => { tableBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(700)
  check('switching back restores the table', $$('table.table tbody tr').length >= 10)

  // Live search: type "monitor" and wait for the debounced refetch.
  const input = window.document.querySelector('input[type="search"]')
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setValue.call(input, 'monitor')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await sleep(50)
  })
  await settle()
  const rows = $$('table.table tbody tr')
  check('search narrows the table', rows.length > 0 && rows.length < 10, `${rows.length} rows`)
  check('search result matches the term', text().toLowerCase().includes('monitor'))

  // A term that matches nothing must show the branded empty state.
  await act(async () => {
    setValue.call(input, 'zzz-no-such-product-zzz')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await sleep(50)
  })
  await settle()
  check('empty state renders the logo mark', $$('.empty .empty-mark').length === 1 && text().includes('No products match'), `${$$('.empty .empty-mark').length} marks`)

  // Reset the filter and open the create-product modal.
  await act(async () => {
    setValue.call(input, '')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await sleep(50)
  })
  await settle()
  const newBtn = $$('button.btn-primary').find((b) => b.textContent.includes('New product'))
  await act(async () => { newBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  check('create modal opens with SKU + name fields', $$('.modal').length === 1 && text().includes('Opening stock'))
  check('the product form has a product-image field with a live preview', $$('.modal .image-field').length === 1 && $$('.modal .image-field .product-art').length === 1 && $$('.modal .image-field input[type="url"]').length === 1)
  check('the form explains that blank means generated artwork', /generated artwork/i.test(text()))
  check('modal header carries the logo mark', $$('.modal .modal-mark').length === 1)
  check('modal renders category datalist from API', $$('#category-options option').length >= 4)
  const close = $$('.modal .icon-btn')[0]
  await act(async () => { close.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  check('modal closes', $$('.modal').length === 0)
}

console.log('\nproduct photo upload')
await goTo('#/products')
{
  /* The whole flow through the real form: type, pick a file, save, then read
     the row back from the API and out of the image endpoint. */
  const photoSku = `UITEST-${STAMP}-PIC`
  const png = readFileSync(new URL('../public/favicon-32.png', import.meta.url))
  const newBtn = $$('button.btn-primary').find((b) => b.textContent.includes('New product'))
  await act(async () => { newBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  check('the form offers a photo file picker beside the URL field', $$('.modal .image-file').length === 1 && /image\/png/.test($$('.modal .image-file')[0].getAttribute('accept') ?? ''), $$('.modal .image-file')[0]?.getAttribute('accept'))

  const setInput = async (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    await act(async () => { await sleep(40) })
  }
  const modalInputs = $$('.modal input')
  await setInput(modalInputs[0], photoSku)
  await setInput(modalInputs[1], 'UI Fixture Photo Widget')
  await setInput(modalInputs[2], 'QA Fixtures')
  // Priced and stocked so the fixture behaves like a real product everywhere
  // the catalogues are charted.
  const numbers = $$('.modal input[type="number"]')
  await setInput(numbers[0], '3')   // cost price
  await setInput(numbers[1], '9')   // sale price
  await setInput(numbers[3], '6')   // opening quantity

  const picker = $$('.modal .image-file')[0]
  const file = new window.File([new Uint8Array(png)], 'widget.png', { type: 'image/png' })
  Object.defineProperty(picker, 'files', { value: [file], configurable: true })
  await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(60) })
  await settle(400)
  check('picking a file flips the field to an upload preview', $$('.modal .image-field[data-photo="upload"]').length === 1)
  check('the preview renders the picked bytes as a real image', $$('.modal .image-field .product-photo').length === 1 && /^data:image\//.test($$('.modal .image-field .product-photo')[0].getAttribute('src') ?? ''), `photos=${$$('.modal .image-field .product-photo').length} src=${String($$('.modal .image-field .product-photo')[0]?.getAttribute('src')).slice(0, 30)}`)
  check('an uploaded picture can be removed again', $$('.modal .image-actions button').some((b) => b.textContent.includes('Remove photo')))

  await act(async () => {
    $$('.modal form')[0].dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await sleep(80)
  })
  await settle(900)
  check('saving an upload closes the form', $$('.modal').length === 0)

  const saved = (await apiCall(`${API}/api/products?search=${photoSku}&active=all`).then((r) => r.json())).items[0]
  check('the form saved the product with its photo', saved?.has_photo === 1 && /\/api\/products\/\d+\/image\?v=\d+/.test(saved?.image_url ?? ''), JSON.stringify(saved?.image_url))
  const served = await apiCall(`${API}${saved.image_url}`)
  const servedBytes = Buffer.from(await served.arrayBuffer())
  check('the saved photo is served back byte-for-byte', served.status === 200 && servedBytes.equals(Buffer.from(png)), `${served.status} ${servedBytes.length}/${png.length}`)
  check('the image endpoint sends an image content type', String(served.headers.get('content-type')).startsWith('image/png'))

  // The list must show the real picture, not the generated tile.
  await setInput(window.document.querySelector('input[type="search"]'), photoSku)
  await settle(900)
  const row = $$('table.table tbody tr').find((r) => r.textContent.includes(photoSku))
  check('the product row shows the stored photo', Boolean(row?.querySelector('img.product-photo')))
  check('a photo row is not also drawn as artwork', !row?.querySelector('.product-art'))

  // Editing it keeps the stored bytes, and Remove clears them.
  const editBtn = [...row.querySelectorAll('button')].find((b) => /edit/i.test(b.textContent) || b.getAttribute('title') === 'Edit')
  check('the photo row offers an edit action', Boolean(editBtn))
  await act(async () => { editBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(80) })
  await settle(600)
  check('editing shows the stored photo as the current picture', $$('.modal .image-field[data-photo="stored"]').length === 1 && $$('.modal .image-field .product-photo').length === 1)
  const removeBtn = $$('.modal .image-actions button').find((b) => b.textContent.includes('Remove photo'))
  await act(async () => { removeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  check('removing falls back to the generated artwork', $$('.modal .image-field[data-photo="none"] .product-art').length === 1)
  await act(async () => {
    $$('.modal form')[0].dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await sleep(80)
  })
  await settle(900)
  const clearedRow = (await apiCall(`${API}/api/products?search=${photoSku}&active=all`).then((r) => r.json())).items[0]
  check('the removal reached the database', clearedRow?.has_photo === 0 && clearedRow?.image_url === '', JSON.stringify(clearedRow?.image_url))

  const purge = await apiCall(`${API}/api/products/${saved.id}?mode=purge`, { method: 'DELETE' })
  check('the photo fixture is cleaned up', purge.ok && (await apiCall(`${API}/api/products?search=${photoSku}&active=all`).then((r) => r.json())).total === 0)
}

console.log('\nstock movements')
await goTo('#/stock')
{
  check('stock page title carries the logo mark', $$('.page-head .head-mark').length === 1)
  check('movement table populated', $$('table.table tbody tr').length >= 10, `${$$('table.table tbody tr').length} rows`)
  check('movement rows show the product artwork', $$('table.table tbody tr').every((r) => r.querySelector('.cell-product .product-art')))
  check('totals strip renders', text().includes('Units received') && text().includes('Units issued'))
  check('in/out chips rendered', $$('.chip-in').length >= 1 && $$('.chip-out').length >= 1)

  const inBtn = $$('button').find((b) => b.textContent.includes('Stock in'))
  await act(async () => { inBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(300) })
  await settle(500)
  check('stock-in dialog opens and lists products', $$('.modal .picker button').length > 0, `${$$('.modal .picker button').length} options`)
  const firstOption = $$('.modal .picker button')[0]
  const pickedSku = firstOption.textContent.split(' ')[0]
  await act(async () => { firstOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  check('selected product card rendered', $$('.selected-product').length === 1)
  // Enter a quantity and confirm the running-balance preview reacts.
  const qtyInput = $$('.modal .form-grid input[type="number"]')[0]
  const setNum = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setNum.call(qtyInput, '5')
    qtyInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await sleep(50)
  })
  check('quantity entry updates the balance preview', /New balance: \d+/.test(text()), text().slice(-200))
  const closeBtn = $$('.modal-foot button').find((b) => b.textContent.includes('Cancel'))
  await act(async () => { closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  check('dialog closes', $$('.modal').length === 0)
  void pickedSku
}

console.log('\nalerts')
await goTo('#/alerts')
{
  check('alerts page title carries the logo mark', $$('.page-head .head-mark').length === 1)
  check('reorder worklist rendered', $$('table.table tbody tr').length >= 1, `${$$('table.table tbody tr').length} rows`)
  check('alert rows show the product artwork', $$('table.table tbody tr').every((r) => r.querySelector('.cell-product .product-art')))
  check('restock action available', $$('button').some((b) => b.textContent.trim() === 'Restock'))
  check('summary strip renders restock cost', text().includes('Estimated restock cost'))
  check('coverage indicators rendered', $$('.coverage').length >= 1)
  const outBtn = $$('.segmented button').find((b) => b.textContent === 'Out of stock')
  await act(async () => { outBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  check('urgency filter switches', $$('.coverage').length === 0 || $$('tbody tr').every((r) => r.textContent.includes('Out of stock') || r.textContent.includes('No products')))
}

console.log('\nreports')
await goTo('#/reports')
{
  await settle(1800)
  const body = text()
  check('reports page title carries the logo mark', $$('.page-head .head-mark').length === 1)
  check('period controls render', body.includes('Reporting period') && $$('input[type="date"]').length === 2)
  check('movement trend chart rendered', $$('svg.chart rect.bar').length > 10, `${$$('svg.chart rect.bar').length} bars`)
  check('valuation KPIs render', body.includes('Cost value') && body.includes('Margin rate'))
  check('category valuation ranks render', $$('.rank-fill').length >= 4)
  check('top throughput table populated', body.includes('Top products by throughput') && $$('table.table tbody tr').length >= 5)
  check('all seven CSV exports wired', $$('a.btn').filter((a) => a.getAttribute('href')?.includes('export.csv')).length === 7, `${$$('a.btn').filter((a) => a.getAttribute('href')?.includes('export.csv')).length}`)

  // --- SaaS visualisation set --------------------------------------------
  await settle(2200)
  const heat = await apiCall(`${API}/api/reports/activity`).then((r) => r.json())
  const healthDoc = await apiCall(`${API}/api/reports/health`).then((r) => r.json())

  const gauge = $$('.gauge-value')
  check('health gauge is a single arc with a full tick scale', gauge.length === 1 && $$('.gauge-tick').length === 28 && $$('.gauge-dot').length === 1)
  const lit = $$('.gauge-tick.on').length
  check('gauge swept to the score (ticks light up as the arc grows)', lit > 8 && lit < 28, `${lit}/28 ticks lit`)
  check('gauge number matches the API health score', /^\d+$/.test($$('.gauge-number')[0].textContent.trim()) && Number($$('.gauge-number')[0].textContent.trim()) === healthDoc.score.value, `${$$('.gauge-number')[0].textContent} vs ${healthDoc.score.value}`)
  check('gauge shows the grade + caption', $$('.gauge-grade')[0].textContent.includes(healthDoc.score.grade) && $$('.gauge-caption')[0].textContent === healthDoc.score.label)

  check('health dimensions render as four animated meters', $$('.card-hero .meter').length === 4 && $$('.card-hero .meter-track > span').every((el) => parseFloat(el.style.width) > 0))
  const meterWidths = $$('.meter-track > span').map((el) => parseFloat(el.style.width))
  check(
    'stock-ageing buckets render as meters too',
    $$('.meter').length === 9 && meterWidths.length === 9 && meterWidths.every((w) => Number.isFinite(w) && w >= 0 && w <= 100) && meterWidths.filter((w) => w > 0).length >= 4,
    `${$$('.meter').length} meters, ${meterWidths.filter((w) => w > 0).length} with width`,
  )
  check('health advisory actions link into the app', $$('.health-action').length === healthDoc.actions.length && $$('.health-action').every((a) => /^#\//.test(a.getAttribute('href') || '')))
  check('hero card carries the animated border', $$('.card-hero').length === 1)

  check('KPI ring strip rendered', $$('.ring-stat').length >= 6, `${$$('.ring-stat').length} rings`)
  check('ring arcs are swept (dash offset below the full circumference)', $$('.ring-value').every((c) => Number(c.getAttribute('stroke-dashoffset')) < Number(c.getAttribute('stroke-dasharray'))))
  const fillRing = $$('.ring-stat').find((el) => text_(el).includes('Fill rate'))
  check('fill-rate ring reports the API value', Boolean(fillRing) && text_(fillRing).includes(String(Math.round(healthDoc.kpis.fill_rate))), fillRing ? text_(fillRing).slice(0, 40) : 'missing')

  const tCells = $$('.treemap-cell')
  const treemapCats = healthDoc.categories.filter((c) => c.value > 0)
  check('capital treemap maps every funded category', tCells.length === treemapCats.length, `${tCells.length} cells vs ${treemapCats.length} categories`)
  check('treemap tiles fill the map from the top-left', tCells.every((c) => parseFloat(c.style.left) >= 0 && parseFloat(c.style.top) >= 0 && parseFloat(c.style.width) > 0 && parseFloat(c.style.height) > 0))
  check('treemap area is square-ish (no zero-height slivers)', tCells.every((c) => parseFloat(c.style.height) / parseFloat(c.style.width) < 12))
  await act(async () => { tCells[0].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); await sleep(60) })
  check('treemap hover drives the readout', $$('.treemap-readout strong')[0]?.textContent === tCells[0].querySelector('.treemap-name').textContent)
  await act(async () => { tCells[0].dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })); await sleep(40) })

  const hCells = $$('.heat-cell')
  const heatCols = Number(/repeat\((\d+),/.exec(window.document.querySelector('.heat-grid').getAttribute('style') || '')?.[1] || 0)
  check('activity heatmap is a full week grid', heatCols >= 4 && hCells.length === heatCols * 7, `${hCells.length} cells for ${heatCols} declared columns (api window ${heat.weeks.length}w)`)
  check('heatmap leaves gaps for inactive days', hCells.some((c) => c.dataset.empty === 'true') && hCells.some((c) => c.dataset.empty === 'false'))
  check('heatmap legend shows the colour scale', $$('.heat-swatch').length === 5)
  const activeCell = hCells.find((c) => c.dataset.empty === 'false')
  await act(async () => { activeCell.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); await sleep(60) })
  check('heatmap hover prints the day readout', /units out/.test(text_(window.document.querySelector('.heat-readout'))), text_(window.document.querySelector('.heat-readout')).slice(0, 60))

  check('waterfall plots received → issued → net', $$('.waterfall-col').length === 3 && $$('.waterfall-total').length === 1 && $$('.waterfall-bar').length === 3)
  check('waterfall bars are anchored to the baseline', $$('.waterfall-bar').every((b) => b.style.bottom !== '' && b.style.height !== ''))

  const stackCols = $$('.stack-col')
  check('in/out composition stacks one column per day (last 21)', stackCols.length === 21, `${stackCols.length} columns`)
  check('stacked columns carry both series', $$('.stack-seg').length === stackCols.length * 2 && $$('.stack-in').length === stackCols.length && $$('.stack-out').length === stackCols.length)

  check('hour-of-day profile is a 24-bar chart', $$('.minibars')[0] && $$('.minibars')[0].querySelectorAll('.minibar').length === 24)
  check('weekday totals profile rendered', $$('.minibars').length >= 2 && $$('.minibars')[1].querySelectorAll('.minibar').length === 7)
  check('mini bars animated to their heights', $$('.minibar > i').every((i) => i.style.height !== ''))

  check('sections reveal on scroll (visible without IntersectionObserver)', $$('.reveal.is-visible').length >= 6, `${$$('.reveal.is-visible').length}`)

  const weekBtn = $$('.segmented button').find((b) => b.textContent === 'Weekly')
  await act(async () => { weekBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  await settle(1000)
  check('weekly grouping renders stacked buckets', $$('.stack-col').length >= 1, `${$$('.stack-col').length} buckets`)

  const preset = $$('.segmented button').find((b) => b.textContent === 'Last 7 days')
  await act(async () => { preset.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50) })
  await settle(1000)
  check('date preset re-runs reports', $$('.stack-col').length >= 1)
}


  // ---- PDF report -------------------------------------------------------
  const reportPdf = window.document.querySelector('.pdf-btn')
  check('reports screen offers the decorated PDF report', reportPdf && /Download PDF report/.test(reportPdf.textContent))
  check('report action keeps the brand mark', reportPdf?.querySelector('svg.logo-mark, .pdf-btn-mark'))
  const reportHref = reportPdf.getAttribute('href')
  const reportRange = new URLSearchParams(reportHref.split('?')[1])
  check('report link carries the selected window', /^\/api\/report\.pdf/.test(reportHref) && reportRange.get('from') && reportRange.get('to'), reportHref)
  check('report link matches the on-screen date inputs', reportRange.get('from') === $$('.inline-field input[type="date"]')[0].value && reportRange.get('to') === $$('.inline-field input[type="date"]')[1].value, reportHref)
  const previewLink = $$('a').find((a) => a.textContent.includes('Preview PDF'))
  check('a preview link opens the PDF inline in a new tab', /inline=1/.test(previewLink?.getAttribute('href') ?? '') && previewLink?.getAttribute('target') === '_blank')
  check('the note explains what the report contains', /six-page/.test(text()) && /product register/.test(text()) && /gallery/i.test(text()))
  const pdfRes = await apiCall(`${API}${reportHref}`)
  const pdfBody = Buffer.from(await pdfRes.arrayBuffer())
  check('the linked PDF actually renders', pdfRes.status === 200 && pdfBody.subarray(0, 5).toString() === '%PDF-', `${pdfRes.status} ${pdfBody.length} bytes`)
  check('the linked PDF is multi-page and decorated', pdfBody.length > 40000 && (pdfBody.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length >= 5)
  const movedRange = $$('.segmented button').find((b) => b.textContent === 'Last 90 days')
  await act(async () => { movedRange.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(600)
  check('report link follows the preset window', window.document.querySelector('.pdf-btn').getAttribute('href').includes(new URLSearchParams(window.document.querySelector('.pdf-btn').getAttribute('href').split('?')[1]).get('from')))
  const back30 = $$('.segmented button').find((b) => b.textContent === 'Last 30 days')
  await act(async () => { back30.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(60) })
  await settle(600)

console.log('\naccess control & account')
{
  const click = async (el, wait = 500) => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(wait)
  }
  const setValue = async (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    await act(async () => { await sleep(30) })
  }
  const apiAccounts = await apiCall(`${API}/api/auth/accounts`).then((r) => r.json())
  const apiEvents = await apiCall(`${API}/api/auth/events?limit=40`).then((r) => r.json())

  const navItems = $$('.nav-item').map((n) => n.textContent.trim())
  check('admin nav offers every section', navItems.length >= 6 && navItems.some((t) => t.includes('Access control')), navItems.join(' | '))
  check('nav covers procurement and counting',
    ['Purchasing', 'Suppliers', 'Stock counts'].every((t) => navItems.some((n) => n.includes(t))), navItems.join(' | '))

  await goTo('#/access')
  check('access screen renders', $$('#admin-screen').length === 1)
  check('access screen lists the whole team', $$('.admin-table tbody tr').length === apiAccounts.accounts.length, `${$$('.admin-table tbody tr').length} vs ${apiAccounts.accounts.length}`)
  check('every row prints an email and a role', $$('.admin-table tbody tr').every((r) => r.querySelector('.admin-who-copy .mono')?.textContent.includes('@') && r.querySelector('.badge')))
  check('row capabilities mirror the role', $$('.admin-caps').map((c) => c.textContent).join(';').includes('read · move · manage · admin'))
  check('your own row is marked', $$('.admin-row-self').length === 1 && /you/.test($$('.admin-row-self')[0].textContent))
  check('session counts match the API', $$('.admin-table tbody tr').map((r) => Number(r.querySelector('td.num').textContent)).join(',') === apiAccounts.accounts.map((a) => a.active_sessions).join(','))
  check('locked accounts show the remaining minutes', $$('.admin-table .badge-out').length === apiAccounts.accounts.filter((a) => a.locked).length)
  check('self-service session revocation is refused in the UI', $$('.admin-row-self .btn-danger-ghost')[0].disabled === true)
  check('role cards explain each capability tier', $$('.admin-role-card').length === 3 && /read-only/i.test($$('.admin-role-card')[2].textContent), $$('.admin-role-card').map((c) => c.textContent.slice(0, 30)).join(' | '))
  check('admin stat strip counts the roles', $$('.admin-stats .stat').length === 5 && /Team accounts/.test(text()))
  check('audit trail lists credential events', $$('.event-list .event-row').length >= Math.min(apiEvents.events.length, 10), `${$$('.event-list .event-row').length} rows`)
  check('audit rows are colour-coded by outcome', $$('.event-dot').length === $$('.event-list .event-row').length && $$('.event-dot').every((d) => /event-(ok|low|out|accent|neutral)/.test(d.className)))
  check('audit rows carry a human label', $$('.event-copy strong').every((s) => s.textContent.length > 2), $$('.event-copy strong')[0]?.textContent)
  const lockFilter = $$('.admin-filter button').find((b) => b.textContent === 'Lockouts')
  await click(lockFilter, 200)
  check('filtering the trail narrows it to lockouts', $$('.event-list .event-row').length <= $$('.event-dot').length && $$('.event-list .event-row').length < apiEvents.events.length)
  await click($$('.admin-filter button').find((b) => b.textContent === 'All'), 200)

  // ---- account panel ----------------------------------------------------
  await click(window.document.querySelector('.session-card'), 400)
  check('the account panel opens from the session card', $$('.modal').length === 1 && /Account/.test($$('.modal-title')[0].textContent))
  check('account panel shows identity + role', /Avery Stone/.test($$('.account-id')[0].textContent) && /Admin/.test($$('.account-id')[0].textContent))
  check('account panel reports live devices', /Live sessions/.test(text()) && /\d device/.test(text()))
  check('password change form is present', $$('.account-form input[type="password"]').length === 3)
  await setValue($$('.account-form input[type="password"]')[1], 'Short')
  check('password meter warns about a weak password', $$('.pw-meter')[0].dataset.score === '1' && /Too short/i.test($$('.pw-meter')[0].textContent))
  await setValue($$('.account-form input[type="password"]')[1], 'Qa-Ui#Password2026')
  check('password meter turns strong for a long mixed password', $$('.pw-meter')[0].dataset.score >= 3, `score=${$$('.pw-meter')[0].dataset.score}`)
  check('sign out is offered in the account panel', $$('.modal-foot .btn-danger-ghost').length === 1)

  // ---- sign out and back in as the read-only viewer ---------------------
  await setCookieJar('') // a real sign-out clears the cookie; mirror that in the harness
  await click($$('.modal-foot .btn-danger-ghost')[0], 900)
  check('signing out returns to the login screen', $$('#login-screen').length === 1 && $$('.app').length === 0)
  check('a signed-out visit carries a notice', /signed out/i.test(window.document.querySelector('.login-notice')?.textContent ?? ''), window.document.querySelector('.login-notice')?.textContent?.slice(0, 60))
  const viewerRow = $$('.demo-row').find((r) => r.classList.contains('demo-role-viewer'))
  await click(viewerRow.querySelector('.demo-fill'), 150)
  window.document.querySelector('.login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await settle(1600)
  check('viewer signs in', $$('.app').length === 1 && /Viewer/.test(window.document.querySelector('.session-role')?.textContent ?? ''))
  const viewerNav = $$('.nav-item').map((n) => n.textContent.trim())
  check('viewer nav hides access control', viewerNav.length === navItems.length - 1 && !viewerNav.some((t) => t.includes('Access control')), viewerNav.join(' | '))
  check('role switch is reflected in the sidebar footer', /Sam Whitfield/.test(window.document.querySelector('.session-card')?.textContent ?? ''))
  await goTo('#/access')
  check('viewer cannot reach the access screen by hash', $$('#admin-screen').length === 0 && $$('.nav-item').length === navItems.length - 1)
  await goTo('#/products')
  check('viewer sees a read-only note instead of create/edit', $$('.role-note').length === 1 && /read-only/i.test($$('.role-note')[0].textContent) && !$$('button').some((b) => b.textContent.includes('New product')))
  check('viewer rows offer no edit action', !$$('table tbody .link-btn').some((b) => b.textContent === 'Edit'))
  await goTo('#/stock')
  check('viewer gets no stock-movement buttons', !$$('button').some((b) => /Stock in|Stock out|Adjust/.test(b.textContent)) && $$('.role-note').length === 1)

  // The Worker still refuses a forced write even though the UI is read-only.
  const asViewer = (path, init = {}) => realFetch(`${API}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie: cookieJar } })
  const viewerSession = await asViewer('/api/auth/session').then((r) => r.json())
  check('viewer session is a real session', viewerSession.authenticated === true && viewerSession.user.role === 'viewer')
  const viewerForced = await asViewer('/api/products', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: `UITEST-VIEW-${STAMP}`, name: 'forced', category: 'QA', cost_price: 1, sale_price: 2 }),
  })
  check('a forced viewer write is still refused by the Worker', viewerForced.status === 403)
}

} finally {
  await cleanupFixtures()
}

await act(async () => { root.unmount() })
await vite.close()

const remaining = await apiCall(`${API}/api/products?search=UITEST-${STAMP}&active=all`).then((r) => r.json())
check('UI fixtures removed after the run', remaining.total === 0, `${remaining.total} left`)

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`)
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'))
process.exit(failed === 0 ? 0 : 1)
