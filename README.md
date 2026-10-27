# StockPilot — Smart Inventory Management System

A single-tenant inventory platform for monitoring products, stock levels and inventory
movement. Runs as a Cloudflare Worker (API + static assets) backed by a D1 SQLite
database, with a React single-page front end.

## Features

| Area | What it does |
| --- | --- |
| **Admin dashboard** | Stock value at cost/retail, units on hand, low-stock and out-of-stock counts, reorder budget, 7/14/30/90-day movement chart, recent activity, value by category, top movers |
| **Product CRUD** | Create, read, update, archive/restore and permanently delete products; unique SKUs; opening stock recorded as a movement |
| **Product images** | Every product is drawn as generated artwork (category family, tone and monogram from its SKU), and can carry a real photo instead — pick a file (downscaled to 512 px in the browser, ≤256 KB stored) or paste a link. Photos are stored in D1 and served by `/api/products/:id/image`; the artwork is the fallback everywhere and in the PDF |
| **Stock in / stock out** | Single moves and bulk receipts/dispatches (up to 100 lines), stocktake adjustments, reversal of any entry. Over-issue is blocked; archived products cannot move stock |
| **Low-stock alerts** | Worklist ordered by coverage, severity badges, suggested reorder quantity, one-click restock, estimated restock cost |
| **Inventory reports** | Movement summary and daily/weekly/monthly trend, stock valuation with margin, category breakdown, top throughput, top value holdings |
| **Health scoring** | Composite 0–100 score with an A–D grade from four weighted dimensions (availability, movement, freshness, balance), fill rate, stockout rate, days of cover, turnover, dormant capital and a ranked action list |
| **Visual analytics** | Animated gauge, KPI rings, capital treemap, weekday × week activity heatmap, hour-of-day profile, stock-ageing meters, net-movement waterfall and stacked in/out columns — all CSV-exportable |
| **Search & filtering** | Free-text search across name/SKU/category/supplier/location, category, stock-status and record-state filters, sortable columns, pagination, date-range filters |
| **CSV export** | Products, movements, valuation, categories and low-stock lists (UTF-8 with BOM for Excel) |
| **PDF report** | One-click decorated report (`/api/report.pdf`) built in the Worker with pdf-lib: branded cover with the health dial, position & valuation, movement analytics with vector charts, the restock worklist with recommended actions, a product gallery that prints every item's artwork or stored photo, and a full product register appendix (spanning two pages) — every download recorded in the audit trail |
| **Authentication** | Session-based admin console: PBKDF2-hashed passwords, hashed session tokens in HttpOnly cookies, three roles (admin / operator / viewer) enforced per route, per-account lockout, password rotation and a credential audit trail — the seeded logins are printed under the login form |
| **Theme & motion** | Dark "Aurora" glass theme with a light variant, switchable in the sidebar and remembered per browser (auto-detects the OS preference on first visit) |
| **Brand** | StockPilot logo throughout (sidebar lockup, every page title, modals, empty/loading states, footer), app icons + PWA manifest, and one cyber watermark — grid, HUD reticle and the outline mark — centred in the viewport |

Every stock change writes to an append-only `stock_movements` ledger with the running
balance, so the audit trail — not just the current quantity — is always available.

## Stack

- **Front end:** React 19 + Vite, hand-rolled SVG charts (no chart library), CSS custom
  properties for theming, no CSS framework.
- **Backend:** a Cloudflare Worker (ES module, plain `fetch` handler) with D1 (SQLite) and
  static asset serving from the same Worker.
- **PDF:** [pdf-lib](https://pdf-lib.js.org) — pure JavaScript, bundled into the Worker, so
  the report needs no headless browser and no third-party rendering service. See
  [`docs/REPORTS.md`](docs/REPORTS.md).
- **Tests:** Node scripts only — `verify-api` against a live Worker, `verify-ui` driving the
  real React app in jsdom against that API.

## Design & motion

The interface is a dark glass theme (`--bg #05070f`, translucent cards over two slowly
drifting aurora blobs) with a light glass variant selected by `[data-theme="light"]` on
`<html>`. Everything on screen is driven by CSS custom properties, so the theme toggle is a
single attribute flip and no component knows which theme is active.

Charts are plain SVG — no charting library — and every one animates itself in:

| Component | Motion |
| --- | --- |
| `BarChart` (bars / area / line) | Bars scale up from the baseline with a 26 ms per-column stagger; the area fades in and the line draws itself with a `pathLength`/`stroke-dashoffset` transition; hover lifts a column highlight and a tooltip |
| `DonutChart` | Arcs sweep out from 0 via a rAF-driven progress value; segments and legend rows highlight each other on hover and the centre label swaps to the hovered slice |
| `Sparkline` | Line draws in and the gradient fill fades up behind the KPI cards |
| `AnimatedNumber` | Ease-out count-up for every KPI and stat value |
| `RankBars` | Track widths sweep out with a staggered delay plus a slow sheen pass |
| `Gauge` | 270° arc, its 28 ticks and a travelling dot all follow one eased progress value |
| `RingStat` | Circular KPI rings whose arc closes as the value animates in |
| `Treemap` | Squarified capital map; tiles scale up in sequence and drive a live readout on hover |
| `Heatmap` | Weekday × week grid; cells fade up on a stagger, brighten by intensity and highlight on hover |
| `Waterfall` | Received → issued → net columns that grow and float to their cumulative position |
| `StackedBars` | Columns scale up per bucket, segments resize on data change, hover prints the detail |
| `MiniBars` | Compact 24-bar hour profile and weekday totals with a hover readout |
| `MeterList` | Labelled meters for the score's dimensions and the stock-ageing buckets |
| Shell extras | Pointer-tracked card spotlight, rotating gradient border on hero cards, reveal-on-scroll sections |
| Shell | Route-change transitions, staggered card rise-in, nav indicator slide, pulsing live-status dot, modal spring, toast slide-in with a countdown bar |

`src/components/ui.jsx` exposes the primitives: `useReducedMotion`, `useGrowIn` and
`useProgress` are the three motion hooks, and they all honour
`prefers-reduced-motion: reduce`, which disables the entire animation layer (verified by
running the UI suite with `REDUCED_MOTION=1`).

## Branding

The logo — an isometric crate with a barcode label, rising bars, a paper plane and an
orbital swoosh, plus a two-tone `STOCK`/`PILOT` wordmark — is authored once in
`src/brand-art.js` and consumed in three ways: the inline React components in
`src/brand.jsx`, the files generated into `public/` by `scripts/build-logo.mjs`, and the
cyber watermark. It ships as the sidebar lockup, next to every page title, in modal
headers, in the empty/loading states, in the page footer and as the favicon/app icon/PWA
icon. The mark always prints on its own light plate so it stays legible on the dark theme.

`<CyberWatermark />` is a **single** emblem centred in the viewport — a faint technical
grid, a glow plate, a rotating dashed HUD ring with corner brackets and a monospace
readout, the outline of the logo, and a slow scanline. It is `currentColor`-driven
(`--cyber-ink`, `--cyber-opacity`), blends with `screen` on dark and `multiply` on light,
sits above the content but below modals and toasts, ignores pointer events, is hidden in
print, and stops rotating and scanning under `prefers-reduced-motion`.

Full details, sizes and regeneration steps: [`docs/BRAND.md`](docs/BRAND.md).
`npm run build:logo` re-emits `public/`; `npm run build:all` does that plus the front end
and the worker bundle.

## Layout

```
worker/
  index.js      router + static asset handling
  report-pdf.js decorated PDF report (page layout engine + five page compositions)
  lib.js        responses, errors, validation, CSV helpers
  schema.js     DDL + deterministic 45-day demo seed
  products.js   product CRUD, search/filter, categories, CSV export
  stock.js      stock in/out, bulk moves, adjustments, reversals
  insights.js   dashboard KPIs, alerts, reports
  auth.js       sessions, roles, lockout, audit trail
src/
  App.jsx       session gate + shell, role-gated navigation, live status
  api.js        API client + formatting helpers
  auth.jsx      session context, capability map, 401 handling
  brand-art.js  logo geometry + watermark glyph (single source of truth)
  brand.jsx     logo, watermark, footer components
  styles.css    design system
  components/   Login, Admin (access control), Account, Dashboard, Products,
                Stock, Alerts, Reports, ui primitives
public/         generated brand assets: logo/favicon/watermark SVGs + PNG app icons
docs/BRAND.md   brand kit and regeneration instructions
docs/AUTH.md    roles, password hashing, sessions, lockout, endpoints, seeded logins
docs/REPORTS.md the PDF report: contents, design, endpoints, how to extend and proof it
scripts/
  build-worker.mjs  bundles worker/ into build/worker.js for deployment
  build-logo.mjs    writes the brand assets from src/brand-art.js
  verify-api.mjs    API assertions
  verify-ui.mjs     DOM + interaction assertions against the real app
```

## Running locally

```bash
npm install
npm run build:all             # brand assets + front end (dist/) + worker bundle
npm run build                 # just the front end into dist/ (served by the Worker)
npm run dev:worker            # Worker API + app on http://localhost:8787
npm run dev                   # Vite dev server on http://localhost:3000, proxies /api to 8787
```

The first API request creates the schema and, on an empty database, seeds 26 demo
products with 45 days of movement history **and the three team accounts**. The app
opens on the login screen; the seeded credentials are printed below the form and can be
filled with one click. Roles, lockout and the audit trail are documented in
[`docs/AUTH.md`](docs/AUTH.md). No migration command is required — DDL
runs as a transactional batch and the seed is skipped once products exist.

## API

```
POST   /api/auth/login              { email, password, remember? } -> session cookie
GET    /api/auth/demo               seeded credentials still using the seeded password
GET    /api/auth/session            { authenticated, user, active_sessions }
POST   /api/auth/logout             revokes the token, clears the cookie
POST   /api/auth/password           { current_password, new_password } (signs other devices out)
GET    /api/auth/accounts           [admin] team, roles, live sessions, lock state
GET    /api/auth/events?limit=      [admin] credential audit trail
POST   /api/auth/unlock             [admin] { email } clears a lockout
POST   /api/auth/revoke             [admin] { email } ends that account's sessions

GET    /api/health                  (public — everything else needs a session)
GET    /api/dashboard?days=14
GET    /api/alerts?threshold=5
GET    /api/categories
GET    /api/products?search=&category=&status=ok|low|out&active=1|0|all&sort=&dir=&page=&limit=
POST   /api/products
GET    /api/products/:id
PUT    /api/products/:id            (quantity edits are logged as adjustments)
DELETE /api/products/:id?mode=archive|purge
POST   /api/products/:id/restore
GET    /api/movements?type=&product_id=&from=&to=&search=&page=&limit=
POST   /api/movements               { product_id, type: in|out|adjust, quantity, unit_cost?, reference?, note? }
POST   /api/movements/bulk          { type: in|out, lines: [{ product_id, quantity }] }
DELETE /api/movements/:id           (posts a compensating reversal)
GET    /api/reports/summary?from=&to=
GET    /api/reports/valuation?category=
GET    /api/reports/movement?from=&to=&group=day|week|month
GET    /api/reports/health?from=&to=                 (score, dimensions, KPIs, ageing, actions)
GET    /api/reports/activity?from=&to=               (week × weekday cells + hour profile)
GET    /api/report.pdf?from=&to=&inline=1        decorated multi-page PDF report (download)
GET    /api/export.csv?type=products|movements|valuation|categories|lowstock|health|activity
```

Errors return `{ "error": "...", "details": ... }` with 400 (validation), 401 (no or
expired session), 403 (role or cross-origin refusal), 404, 405, 409 (conflict /
insufficient stock), 429 (locked account) or 500. Every route declares the capability
it needs (`public` → `read` → `move` → `manage` → `admin`); nothing is authenticated
by accident.

## Verification

```bash
npm run dev:worker &          # API must be reachable on :8787
npm run verify:api            # 319 checks: auth, roles, lockout, CRUD, stock maths, procurement, cycle counting, reports, CSV, PDF
npm run verify:ui             # 234 checks: login flow, roles, every screen, brand, charts, PDF link, procurement, cycle counting
npm run verify:ui:reduced     # same suite down the prefers-reduced-motion path
npm run verify                # all three, in order
```

Build first (`npm run build:all`): the UI suite also fetches the served brand assets from
the Worker to prove the icons and manifest are wired up.

Both suites build and clean up their own fixtures (`UITEST-*`, `QA-*` products), so they
never depend on — or damage — whatever data is already in the database.

The UI suite drives the real React app inside jsdom against the live API: it searches,
opens and closes modals, switches chart types, toggles the theme, and asserts on rendered
output (bar counts, donut arc geometry, count-up values matching the API exactly once the
animation has settled, rank-bar widths after animating). It also checks the brand contract
(the lockup and wordmark on every screen, the single centred watermark emblem and its shared
geometry, theme ink variables, blend modes, reduced-motion and print rules, and that every
generated file in `public/` is byte-identical to `src/brand-art.js`) and the visualisation
contract: the gauge sweeps to the API's score, the ring strip matches the health KPIs, the
treemap covers every funded category and drives its readout on hover, the heatmap is a full
weekday grid with live hover detail, the waterfall/stacked/mini-bar charts animate to real
heights, and no section is left hidden by the reveal-on-scroll wrapper.

The UI suite starts signed out: it asserts the login screen, reads the credentials
panel (including per-row reveal), fails a sign-in to prove the error state, then signs
in through the form itself — every later request rides the cookie captured from the
`Set-Cookie` header. It then walks the admin-only access console, opens the account
panel, signs out, signs back in as the viewer, and checks the read-only layout before
forcing a viewer write to prove the Worker still refuses it.

The PDF report is checked from the outside in: the API suite asserts the response headers,
page objects and — by inflating the Flate-compressed content streams and decoding the text
operators — that the rendered document really contains the cover title, the brand, the
requester, the health score and grade, every KPI label and all five section headings; the UI
suite asserts that both screens link to it with the window currently on screen and that
fetching that link returns a multi-page PDF. The report's *appearance* was proofed by
rasterising it page by page with pdfium and looking at every page
(see [`docs/REPORTS.md`](docs/REPORTS.md)).

jsdom has no CSS engine, so **layout, colour and CSS keyframes are not machine-verified** —
the logo and watermark were proofed by rasterising the real component output, and the final
judgement is the browser preview.

To prove the *deployed* artifact behaves identically, build the bundle and run the
same suite against it (it gets its own database name, so seeding is exercised too):

```bash
npm run build:all
npx wrangler dev --config wrangler.bundle-check.toml --port 8788 &
node scripts/verify-api.mjs http://127.0.0.1:8788
```

## Deployment notes

- `npm run build:all` produces `dist/` (static, including the brand assets from `public/`)
  and `build/worker.js` (single ES module).
- Deploy with `dist/` as the assets directory and `build/worker.js` as the entrypoint,
  plus a D1 binding named `DB`. The Worker bundle is ~1 MB raw / ~250 KB gzipped, mostly
  pdf-lib for the PDF report; both are comfortably inside the Workers script limits.
- The Worker is a plain fetch handler: API routes first, then `env.ASSETS.fetch()`, with
  `index.html` as the fallback for client-side routes.
- Authentication is built in ([`docs/AUTH.md`](docs/AUTH.md)). Before a real deployment:
  set `DEMO_CREDENTIALS = "off"` in `wrangler.toml` (hides the credential readout and the
  `/api/auth/demo` list), sign in as the seeded admin and rotate the three demo passwords
  from the account panel, and serve over HTTPS so the session cookie is issued `Secure`.
- Sessions live in D1 (`auth_sessions`), so no extra store is required; expired rows are
  ignored on read and can be pruned with a scheduled task if you want the table small.
- The theme is stored in `localStorage` under `stockpilot:theme`; the session token is
  never touched by JavaScript — it stays in the HttpOnly cookie.
