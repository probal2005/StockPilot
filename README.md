# 📦 StockPilot — Smart Inventory Management System

<p align="center">
  <strong>A modern, analytics-driven inventory management platform.</strong>
  <br />
  Track products, manage stock movements, monitor inventory health, and generate detailed reports through a polished, interactive dashboard.
</p>

<p align="center">
  <a href="https://stock-pilot-noms.vercel.app/">
    <img src="https://img.shields.io/badge/🚀_LIVE_APPLICATION-Open_StockPilot-16a34a?style=for-the-badge" alt="Open StockPilot Live Application" />
  </a>
  <a href="https://stockpilot.probaldhali2006.workers.dev/">
    <img src="https://img.shields.io/badge/⚙️_BACKEND_API-Cloudflare_Workers-f38020?style=for-the-badge" alt="StockPilot Cloudflare Worker" />
  </a>
</p>

<p align="center">
  <a href="https://stock-pilot-noms.vercel.app/">Live Application</a>
  &nbsp; • &nbsp;
  <a href="https://stockpilot.probaldhali2006.workers.dev/">Backend Worker</a>
</p>

---

## 🌐 Live Demo

| Resource | Description | Link |
|---|---|---|
| **Live Application** | Open the StockPilot web interface and explore the dashboard and inventory workflows. | [Launch StockPilot](https://stock-pilot-noms.vercel.app/) |
| **Backend API** | Access the Cloudflare Worker deployment, which serves the API and application assets. | [Open Worker](https://stockpilot.probaldhali2006.workers.dev/) |

**Start here:** Visit the live application to explore StockPilot. The Worker URL is provided for backend access and API diagnostics; it is not a separate dashboard.

> Demo access is available through the login screen when demo credentials are enabled. Use only the intended demo accounts, and never reuse demo passwords for personal or production accounts.

## 📖 Overview

StockPilot is a single-tenant inventory management platform designed to help teams monitor products, stock levels, inventory movements, and operational performance from one place.

The application combines a React single-page interface with a Cloudflare Worker backend and a Cloudflare D1 SQLite database. It includes inventory CRUD operations, stock-in and stock-out workflows, low-stock alerts, supplier and purchasing workflows, cycle counting, role-based access control, visual analytics, and downloadable CSV and PDF reports.

Every stock change is recorded in an append-only `stock_movements` ledger with a running balance. This preserves movement history and supports auditability instead of relying only on the current quantity.

## ✨ Features

### 📊 1. Admin Dashboard

- Stock valuation at cost and retail prices.
- Total units on hand.
- Low-stock and out-of-stock counts.
- Reorder budget and inventory health indicators.
- Configurable 7-, 14-, 30-, and 90-day movement charts.
- Recent inventory activity and category valuation.
- Top-moving products and stock alerts.
- Animated KPI cards, gauges, rings, and sparklines.

### 📦 2. Product Management

- Create, view, edit, archive, restore, and permanently delete products.
- Unique SKU validation.
- Product categories, suppliers, and storage locations.
- Searchable, sortable, paginated product tables.
- Filters for category, stock status, and record state.
- Opening stock recorded as an inventory movement.

### 🖼️ 3. Product Images and Artwork

Every product can display generated artwork or a real product photograph.

- Category-based artwork with a generated tone and SKU monogram.
- Upload a photo or provide an image URL.
- Browser-side image downscaling to 512 pixels.
- Stored photos limited to 256 KB.
- Images stored in D1 and served through `/api/products/:id/image`.
- Generated artwork used as the fallback in the interface and PDF reports.
- Live previews when selecting or editing a product image.

### 🔄 4. Stock In, Stock Out, and Adjustments

- Record individual stock receipts and dispatches.
- Process bulk receipts or dispatches with up to 100 lines.
- Perform stocktake adjustments.
- Reverse an existing movement using a compensating ledger entry.
- Prevent issuing more stock than is available.
- Block stock movements for archived products.
- Maintain a running inventory balance and a traceable movement history.

### 🚨 5. Low-Stock Alerts and Replenishment

- Reorder worklist organized by stock coverage and severity.
- Suggested reorder quantities.
- One-click restocking actions.
- Estimated replenishment costs.
- Low-stock and out-of-stock indicators.
- Filters for urgency and replenishment status.

### 📈 6. Inventory Reports and Analytics

- Movement summaries and daily, weekly, and monthly trends.
- Stock valuation and margin analysis.
- Category-level inventory breakdowns.
- Top-throughput products and highest-value holdings.
- Inventory health score from 0 to 100, with an A–D grade.
- Availability, movement, freshness, and balance dimensions.
- Fill rate, stockout rate, days of cover, and turnover.
- Dormant capital analysis and ranked improvement actions.
- Stock-ageing buckets and inventory coverage indicators.

### 📉 7. Interactive Data Visualizations

StockPilot uses hand-built SVG visualizations instead of a charting library.

| Visualization | Purpose |
|---|---|
| Bar, area, and line charts | Analyze inventory movement trends |
| Donut chart | Explore category distribution |
| Sparklines | Show compact KPI trends |
| Animated number counters | Highlight key metrics |
| Ranked bars | Compare top-moving products |
| Health gauge | Display inventory health and grade |
| KPI rings | Visualize inventory performance indicators |
| Capital treemap | Compare inventory value by category |
| Activity heatmap | Explore weekday and weekly patterns |
| Waterfall chart | Compare stock received, issued, and net movement |
| Stacked bars | Compare stock-in and stock-out activity |
| Hourly and weekday profiles | Identify movement patterns |
| Meter lists | Examine health dimensions and stock ageing |

Charts include animated transitions, hover interactions, contextual readouts, and reduced-motion support. Relevant analytics can also be exported as CSV.

### 🔎 8. Search, Filtering, and Navigation

- Free-text search across product names, SKUs, categories, suppliers, and locations.
- Category and stock-status filters.
- Active, archived, and all-record views.
- Sortable columns and pagination.
- Date-range filters for reports and inventory activity.
- Responsive navigation with role-aware sections.

### 📤 9. CSV Exports

Export operational data for spreadsheet analysis and external reporting.

- Products
- Stock movements
- Inventory valuation
- Categories
- Low-stock worklists
- Inventory health
- Activity analytics

CSV exports use UTF-8 with a byte-order mark (BOM) for improved compatibility with spreadsheet applications such as Microsoft Excel.

### 📄 10. Decorated PDF Reports

Generate a multi-page PDF report directly from the Worker using `pdf-lib`.

The report can include:

- Branded cover and inventory health dial.
- Inventory position and valuation.
- Movement analytics with vector charts.
- Restocking recommendations and worklist.
- Product gallery containing generated artwork or stored photos.
- Full product register appendix spanning multiple pages.
- Audit-trail recording for report downloads.

The PDF is generated without a headless browser or a separate document-rendering service.

See [`docs/REPORTS.md`](docs/REPORTS.md) for report details and extension guidance.

### 🔐 11. Authentication and Access Control

- Session-based authentication.
- PBKDF2 password hashing.
- Hashed session tokens stored in D1.
- HttpOnly session cookies.
- Three roles: `admin`, `operator`, and `viewer`.
- Per-account login lockout.
- Password rotation.
- Session revocation.
- Credential audit trail.
- Server-side authorization enforced for protected routes.

Permissions are enforced by the Worker, not just by hiding interface controls. For example, a viewer's unauthorized write request is still rejected by the backend.

See [`docs/AUTH.md`](docs/AUTH.md) for authentication, roles, sessions, and endpoints.

### 🛒 12. Procurement and Cycle Counting

The application also includes purchasing and inventory-verification workflows, including:

- Supplier management.
- Purchase orders and replenishment workflows.
- Receiving and purchase-order transitions.
- Cycle-count creation and updates.
- Count posting and inventory reconciliation.
- Role-aware access to procurement and counting operations.

### 🎨 13. Theme, Branding, and Motion

- Dark Aurora glass theme.
- Light theme alternative.
- Theme preference persisted per browser.
- Initial theme selection based on operating-system preference.
- Custom StockPilot logo, wordmark, and application icons.
- Branded sidebar, page titles, modals, empty states, and footer.
- Progressive chart animations and interactive hover effects.
- Animated navigation, modals, toasts, and card transitions.
- Cyber watermark featuring a technical grid, HUD ring, logo outline, and scanline.
- Reduced-motion support through `prefers-reduced-motion`.
- Watermark and animation behavior adjusted for printing and accessibility.

The interface is driven by CSS custom properties, allowing the theme to switch without individual components needing to know which theme is active.

## 🧰 Technology Stack

<p>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/Vite-Frontend-646CFF?style=flat&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/JavaScript-ES_Modules-F7DF1E?style=flat&logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/Cloudflare-D1_SQLite-F38020?style=flat&logo=cloudflare&logoColor=white" alt="Cloudflare D1" />
  <img src="https://img.shields.io/badge/PDF-pdf--lib-red?style=flat" alt="pdf-lib" />
</p>

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite |
| UI and styling | Custom CSS, CSS custom properties, SVG |
| Backend | Cloudflare Workers, JavaScript ES modules |
| Database | Cloudflare D1 (SQLite) |
| PDF generation | `pdf-lib` |
| Static assets | Cloudflare Worker asset binding |
| API testing | Node.js verification scripts |
| UI testing | jsdom and Node.js verification scripts |
| Frontend hosting | Vercel |
| Backend hosting | Cloudflare Workers |

No CSS framework or charting library is required.

## 🏗️ Architecture

```text
                    ┌─────────────────────────┐
                    │      User / Browser     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   React + Vite Frontend │
                    │  Dashboard / Inventory  │
                    └────────────┬────────────┘
                                 │ HTTPS /api
                    ┌────────────▼────────────┐
                    │    Cloudflare Worker    │
                    │  Routing / Auth / Logic │
                    └───────┬─────────┬────────┘
                            │         │
                  ┌─────────▼───┐ ┌───▼────────────┐
                  │ Cloudflare  │ │ Static Assets  │
                  │ D1 / SQLite │ │ HTML / JS / CSS│
                  └─────────────┘ └────────────────┘
```

The live frontend is available through Vercel. API requests from the frontend use the relative `/api` path and are rewritten to the Cloudflare Worker. The Worker handles API routes, authentication, business logic, PDF generation, and static assets.

## 📁 Project Structure

```text
StockPilot/
├── worker/
│   ├── index.js          # API router and static asset handling
│   ├── report-pdf.js     # Multi-page PDF report generation
│   ├── lib.js            # Responses, errors, validation and CSV helpers
│   ├── schema.js         # Database schema and demo seed
│   ├── products.js       # Product CRUD, filters and exports
│   ├── stock.js          # Stock movements and adjustments
│   ├── insights.js       # Dashboard, alerts and analytics
│   ├── auth.js           # Authentication, sessions, roles and audit
│   ├── procure.js        # Supplier and purchase-order workflows
│   └── counts.js         # Cycle-count workflows
├── src/
│   ├── App.jsx           # Session gate and application shell
│   ├── api.js            # API client and formatting helpers
│   ├── auth.jsx          # Session context and capability map
│   ├── brand-art.js      # Logo geometry and watermark source
│   ├── brand.jsx         # Logo, watermark and footer components
│   ├── styles.css        # Design system and themes
│   └── components/
│       ├── Login.jsx
│       ├── Dashboard.jsx
│       ├── Products.jsx
│       ├── Stock.jsx
│       ├── Alerts.jsx
│       ├── Reports.jsx
│       ├── Admin.jsx
│       ├── Account.jsx
│       └── ui.jsx
├── public/               # Brand assets, icons and PWA manifest
├── docs/
│   ├── AUTH.md           # Authentication and authorization
│   ├── BRAND.md          # Brand assets and regeneration
│   └── REPORTS.md        # PDF reports and design
├── scripts/
│   ├── build-worker.mjs  # Worker bundle builder
│   ├── build-logo.mjs    # Brand asset generator
│   ├── verify-api.mjs    # API verification suite
│   └── verify-ui.mjs     # UI and interaction verification
├── index.html
├── package.json
├── vercel.json
├── wrangler.toml
└── README.md
```

## ⚙️ Run Locally

### Prerequisites

- Node.js and npm.
- A Cloudflare account for Worker and D1 development.
- Wrangler CLI, available through `npx wrangler`.
- A configured D1 database for the full backend workflow.

### 1. Clone the repository

```bash
git clone https://github.com/probal2005/StockPilot.git
cd StockPilot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the application

```bash
npm run build:all
```

This generates the brand assets, builds the frontend into `dist/`, and bundles the Worker into `build/worker.js`.

### 4. Start the Worker locally

```bash
npm run dev:worker
```

The Worker development server is expected at:

`http://localhost:8787`

### 5. Start the Vite development server

Open another terminal in the project directory:

```bash
npm run dev
```

The Vite server is expected at:

`http://localhost:3000`

Vite proxies `/api` requests to the local Worker.

### Available build commands

```bash
npm run build       # Build the frontend into dist/
npm run build:all   # Build brand assets, frontend and Worker bundle
npm run build:logo  # Regenerate brand assets
```

The first API request initializes the database schema. On an empty database, the application seeds demo products, historical movements, and team accounts. Seeding is skipped after products already exist.

## 🔌 API Reference

All protected routes require a valid session unless otherwise specified.

### Authentication

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Sign in using email and password |
| `GET` | `/api/auth/demo` | Demo-account information when enabled |
| `GET` | `/api/auth/session` | Inspect the current session |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `POST` | `/api/auth/password` | Change the current password |
| `GET` | `/api/auth/accounts` | Admin: list accounts, roles, and session status |
| `GET` | `/api/auth/events?limit=` | Admin: inspect credential audit events |
| `POST` | `/api/auth/unlock` | Admin: unlock an account |
| `POST` | `/api/auth/revoke` | Admin: revoke an account's sessions |

### Inventory and Operations

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Public health check |
| `GET` | `/api/dashboard?days=14` | Dashboard metrics |
| `GET` | `/api/alerts?threshold=5` | Low-stock alerts |
| `GET` | `/api/categories` | Product categories |
| `GET` | `/api/products` | Search, filter, sort, and paginate products |
| `POST` | `/api/products` | Create a product |
| `GET` | `/api/products/:id` | Retrieve a product |
| `PUT` | `/api/products/:id` | Update product details |
| `DELETE` | `/api/products/:id?mode=archive` | Archive a product |
| `DELETE` | `/api/products/:id?mode=purge` | Permanently delete a product |
| `POST` | `/api/products/:id/restore` | Restore an archived product |
| `GET` | `/api/products/:id/image` | Retrieve a product image |
| `GET` | `/api/movements` | Search and filter stock movements |
| `POST` | `/api/movements` | Record a stock movement |
| `POST` | `/api/movements/bulk` | Record bulk stock movements |
| `DELETE` | `/api/movements/:id` | Reverse a movement |
| `GET` | `/api/reports/summary?from=&to=` | Movement and inventory summary |
| `GET` | `/api/reports/valuation?category=` | Inventory valuation |
| `GET` | `/api/reports/movement?from=&to=&group=` | Movement trends |
| `GET` | `/api/reports/health?from=&to=` | Health score and recommendations |
| `GET` | `/api/reports/activity?from=&to=` | Activity heatmap and hourly profile |
| `GET` | `/api/report.pdf?from=&to=` | Generate a decorated PDF report |
| `GET` | `/api/export.csv?type=products` | Export supported data to CSV |

The products endpoint supports query parameters such as `search`, `category`, `status`, `active`, `sort`, `dir`, `page`, and `limit`. The movement endpoint supports filters such as `type`, `product_id`, `from`, `to`, `search`, `page`, and `limit`.

Stock movement requests accept types such as `in`, `out`, and `adjust`. Bulk movement requests contain a list of product IDs and quantities.

Error responses follow this general structure:

```json
{
  "error": "Human-readable error message",
  "details": null
}
```

Common HTTP status codes include `400` for validation errors, `401` for missing or expired sessions, `403` for authorization or origin-policy refusals, `404` for missing resources, `405` for unsupported methods, `409` for conflicts or insufficient stock, `429` for account lockout, and `500` for unexpected server errors.

## 🧪 Verification and Testing

StockPilot includes automated API and UI verification scripts.

| Command | Purpose |
|---|---|
| `npm run verify:api` | Verify API behavior, authentication, inventory operations, reports, and exports |
| `npm run verify:ui` | Verify login, roles, UI interactions, charts, branding, and reports |
| `npm run verify:ui:reduced` | Exercise the UI with reduced-motion preferences |
| `npm run verify` | Run the complete verification sequence |

Build the application first:

```bash
npm run build:all
```

Start the local Worker in one terminal:

```bash
npm run dev:worker
```

Then run the API suite in another terminal:

```bash
npm run verify:api
```

Run the UI suite:

```bash
npm run verify:ui
```

The UI tests use jsdom to exercise the real React application against the API, including authentication flows, role-based restrictions, charts, theme switching, exports, and PDF links.

The test suites create and clean up their own fixtures. They are designed to avoid depending on or damaging existing inventory records.

**Testing limitation:** jsdom does not implement a full browser CSS layout engine. Browser-based visual inspection is still needed to assess actual layout, colors, and animation appearance.

## 🚀 Deployment

### Frontend

The frontend is deployed on Vercel:

**Live application:** https://stock-pilot-noms.vercel.app/

The repository's `vercel.json` rewrites `/api` requests to the Cloudflare Worker.

### Backend

The Worker is deployed on Cloudflare:

**Worker endpoint:** https://stockpilot.probaldhali2006.workers.dev/

The Worker uses a D1 database binding named `DB` and an asset binding named `ASSETS`.

### Build and deployment workflow

```bash
npm install
npm run build:all
npx wrangler deploy
```

Before deploying, verify the following:

- The configured D1 database exists and the `DB` binding points to the intended database.
- The Worker entry point and static asset directory match the deployment configuration.
- The frontend rewrite targets the correct Worker URL.
- Production environment variables are configured correctly.
- Authentication and demo-account behavior have been reviewed for production use.
- The built application and verification suites pass.

The deployment command publishes the Worker and its configured assets. It does not automatically guarantee that a separate Vercel deployment has updated; confirm that the frontend deployment is also current when its assets change.

## 🔒 Security Notes

StockPilot includes server-side authentication, hashed passwords, session-token hashing, HttpOnly cookies, account lockout, role-based authorization, and origin validation for write requests.

Before using the application with real inventory or accounts:

1. **Disable public demo credentials.** Set `DEMO_CREDENTIALS = "off"` in the production Worker configuration and verify that `/api/auth/demo` no longer exposes demo passwords.
2. **Rotate seeded passwords.** Sign in using the intended administrative account and change all seeded account passwords.
3. **Use unique credentials.** Never reuse demo passwords for personal or production accounts.
4. **Protect production configuration.** Keep secrets out of source control and configure sensitive values through the appropriate deployment settings.
5. **Review access roles.** Assign the minimum required permissions to operators and viewers.
6. **Use HTTPS.** Ensure the application and session-cookie settings are appropriate for secure production traffic.
7. **Review backups and recovery.** Establish an appropriate backup and restore process for production inventory data.
8. **Validate deployment settings.** Confirm the live Worker and frontend are using the intended configuration before handling real business data.

The seeded demo login information is intended for demonstration only. Public demo access should not be treated as a production authentication strategy.

## 🎨 Branding and Design

StockPilot's visual identity is authored from a single source in `src/brand-art.js`.

The brand system generates the React logo components, SVG assets, application icons, and cyber watermark. This keeps the brand geometry consistent across the interface.

The cyber watermark is a single centered emblem with a technical grid, glow plate, HUD ring, corner brackets, logo outline, and scanline. It is designed to remain decorative, ignore pointer events, adapt to the current theme, stay behind modals, and respect reduced-motion and print preferences.

Regenerate the brand assets with:

```bash
npm run build:logo
```

For the complete brand kit and regeneration details, see [`docs/BRAND.md`](docs/BRAND.md).

## 🗺️ Roadmap and Extension Ideas

Potential future improvements include:

- Automated low-stock notifications.
- Scheduled inventory and valuation reports.
- Barcode and QR-code scanning.
- Advanced supplier performance analytics.
- Multi-warehouse inventory management.
- Import workflows for external inventory spreadsheets.
- More comprehensive backup and restore tooling.
- Additional integration and end-to-end browser tests.

These are potential extensions rather than claims about currently implemented functionality.

## 🤝 Contributing

Contributions, bug reports, and feature suggestions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and run the relevant verification scripts.
4. Open a pull request describing the changes and the tests performed.

Keep changes focused, preserve server-side authorization checks, and avoid committing credentials, local databases, or generated build artifacts unless the project explicitly requires them.

## 📄 Documentation

- [Authentication and Authorization](docs/AUTH.md)
- [Branding and Asset Generation](docs/BRAND.md)
- [PDF Reports](docs/REPORTS.md)

## 👨‍💻 Author

<div align="center">

<img src="https://github.com/probal2005.png" alt="Probal Dhali - GitHub Profile" width="140" height="140" style="border-radius: 50%;" />

Probal Dhali

Full-Stack Developer | AIML Student | Software Engineer in Progress

Building practical software solutions with modern web technologies, clean UI design, and a focus on real-world usability.

Project: StockPilot — Smart Inventory Management System

🌐 Live Application · ⚙️ Worker / API

</div>

## 📜 License

Add the appropriate license file and update this section before distributing the project under a specific open-source license.

---

<p align="center">
  <strong>StockPilot — Know Your Stock. Make Smarter Decisions.</strong>
  <br />
  <a href="https://stock-pilot-noms.vercel.app/">Launch Live Application</a>
  &nbsp; • &nbsp;
  <a href="https://stockpilot.probaldhali2006.workers.dev/">Backend Worker</a>
</p>
