# PDF reporting

`GET /api/report.pdf` renders a decorated, seven-page inventory report from the live
database and returns it as a download. The Reports screen and the Dashboard both link
to it, carrying whatever window is on screen.

```
GET /api/report.pdf?from=2026-09-13&to=2026-10-12     # attachment (default)
GET /api/report.pdf?from=...&to=...&inline=1          # opens in the browser
```

| Response header | Meaning |
| --- | --- |
| `content-type` | `application/pdf` |
| `content-disposition` | `attachment; filename="stockpilot-report-<from>_<to>.pdf"` (or `inline` with `inline=1`) |
| `x-report-id` | Document id printed on the cover, e.g. `SP-20260913-KONY` |
| `x-report-pages` | Page count, so a client can show progress |
| `cache-control` | `private, no-store` — the cover names the requester |

Generating one is an auditable act: the Worker writes `report_generated` (with the
document id) to the `auth_events` trail, visible on the **Access control** screen.

## What is inside

| Page | Content |
| --- | --- |
| 1 | Cover: brand lockup, report title, reporting window, meta strip (prepared for, data window, document id, source), **health score dial** with grade, eight key-indicator tiles, the four weighted score dimensions as meters, and a contents list |
| 2 | Position & valuation: capital position strip, cost value by category, **age of stock** (segmented bar + legend + bucket table), top holdings by value |
| 3 | Movement analytics: throughput strip, **daily in/out column chart**, weekday × week heat grid with an hour-of-day profile, top throughput table |
| 4 | Attention & actions: restock worklist with coverage and cost, recommended actions, recent movement ledger |
| 5 | Appendix: **product gallery** — three columns of tiles, largest holding first, each with the product's artwork (or its stored photo, embedded as an image object when one exists), name, SKU, category, quantity, value and status |
| 6 | Appendix: product register (all active products, largest holding first, with on-hand, reorder point, cost, sale price, value and status) || 7 | Appendix: product register continued, plus method and definitions |


Every page carries the same furniture: a brand rule across the top, the section title
with a small logo mark, the document id, and a footer with the gradient rule, brand
line, generation timestamp and `Page n of m`.

## How it is built

No third-party rendering service and no headless browser. `worker/report-pdf.js` composes
the document with [pdf-lib](https://pdf-lib.js.org) (pure JavaScript, runs inside the
Worker) and pulls its data from the same handlers the JSON API serves, so the report and
the screens can never disagree:

```
worker/report-pdf.js
  palette + formatters      brand colours, currency/number formatting, WinAnsi sanitiser
  weight tables             compact stat rows, large tables with zebra rows and status chips
  components                panels, KPI tiles, bar lists, heat grid, column chart, 270° health dial
  Sheet                     page flow: cursor, automatic page breaks, header/footer furniture
  build()                   the seven page compositions
  reportPdf()               params -> data -> document -> Response
```

Design decisions worth knowing:

- **Light, print-first palette** — the report is a document, not a screenshot of the dark
  app theme. It uses the brand navy/blue on white with the aurora accent palette for tones,
  so it reads well on paper and in a PDF viewer's night mode.
- **The logo is vector**, drawn from the same `src/brand-art.js` geometry the app renders
  (crate, barcode label, rising bars, paper plane, orbital swoosh), so the mark in the PDF
  can never drift from the mark in the app.
- **Colour-coded semantics** throughout: green = healthy/in stock, amber = low/locked,
  rose = out of stock/dangerous, blue/indigo = neutral analytics.
- **Automatic pagination** — `card()` measures itself and moves to a new page rather than
  running into the footer, so a large catalogue or a long worklist cannot clip.
- **WinAnsi safe** — every string passes through `sanitize()`, which maps the app's arrows
  and emoji to words and drops anything Helvetica cannot encode.

## Extending it

- **A new card**: add a `sheet.card({ title, content: <measured height>, draw })` inside the
  relevant page block in `build()`. `sheet.tableHeight(rows)`, `barsHeight(rows)`,
  `statsHeight(items)` and `metersHeight(n)` give the height for the common bodies.
- **A new page**: `sheet.newPage({ title, kicker })` then compose; footers are added for
  every page at the end by `finishFooters()`.
- **A new colour or component**: keep it in the palette and the `Sheet` class so the
  document stays consistent.

## Proving it visually

The automated suites assert structure and content (see below), but PDF *look* has to be
eyed. Rasterise it locally:

```bash
pip install --target=.tools pypdfium2 pypdf      # one-off, .tools/ is gitignored
PYTHONPATH=.tools python3 .tools/render.py report.pdf .tools/out/page
# -> .tools/out/page-1.png ... one image per page
```

## What is verified automatically

`npm run verify:api` (27 checks) covers: a signed-out `401`, the PDF magic bytes and EOF,
size, the dated filename, the `x-report-id` / `x-report-pages` headers, `no-store`, one
`/Type /Page` object per reported page, the inverted-range `400`, a default (no-params)
render, the `report_generated` audit event, and — by inflating the Flate streams and
decoding the text operators — that the document really contains the cover title, both
brand words, the requester, the window, the document id, the health score and grade, every
KPI label, all five section headings, and a real product from the database. A separate
section drives a real upload end to end and asserts that the gallery page notes the stored
photo and that the document then carries an image object.

`npm run verify:ui` additionally checks that the Dashboard and Reports screens render the
download action with the brand mark, that its `href` tracks the range or preset currently
selected, that the preview link opens inline, and that fetching the linked URL returns a
multi-page PDF.
