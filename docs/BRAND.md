# StockPilot brand kit

The logo, the app icons and the cyber watermark all come from **one** piece of
artwork: [`src/brand-art.js`](../src/brand-art.js). Nothing hand-copies paths anywhere
else, and the UI suite fails if a generated file drifts from that source.

## The mark

An isometric **crate** with a barcode shipping label, three **rising bars**, a **paper
plane** flying out of it and an **orbital swoosh** wrapping the whole group.

| Part | Value |
| --- | --- |
| Navy | `#0A2A63` — crate front-left face, plane body, `STOCK` |
| Navy light | `#16407C` — crate front-right face, plane wing |
| Brand blue | `#2E6FE3` — lid half, middle bar, orbit |
| Bright blue | `#4C8DF6` — second lid half, tallest bar, `PILOT` |
| Deep blue | `#2059BC` — shortest bar |
| Orbit | `#1E58CE` tapered crescent, `rot -14°`, sampled from two ellipses |
| Plate | `#F7FAFF` rounded square (`rx 27`) the mark is always printed on |
| Wordmark | `STOCK` in navy + `PILOT` in blue, 800 weight, `0.055em` tracking |
| Tagline | `SMART INVENTORY SYSTEM`, monospace, `0.22em` tracking |

The crate, bars and plane stay inside a 14 → 116 box on a 128 unit grid, and the lid
deliberately covers the bars' bases so they read as *coming out of* the crate.

Because the artwork is dark, it always sits on its own light plate (`logo-chip`). That is
what keeps it legible on the dark Aurora theme, on the icons and in print.

## Where it appears

| Surface | Element | File |
| --- | --- | --- |
| Sidebar lockup (mark + two-tone wordmark + tagline) | `<Logo size={40} />` | `src/App.jsx` |
| Page titles (all five screens) | `<LogoMark size={36} className="head-mark" />` | `src/components/*.jsx` |
| Modal headers | `<LogoMark size={30} className="modal-mark" />` | `src/components/ui.jsx` |
| Empty and loading states | `.empty-mark`, `.skeleton-mark` | `src/components/ui.jsx` |
| Sidebar ghost + footer credit | `GhostMark`, `BrandCredit` | `src/App.jsx`, `src/brand.jsx` |
| Page footer | `BrandFooter` | `src/App.jsx` |
| Cyber watermark over the whole app | `<CyberWatermark />` | `src/App.jsx` |
| Tab icon, home-screen icon, PWA | `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png`, `manifest.webmanifest` | `index.html`, `public/` |

## The cyber watermark

`<CyberWatermark />` is **one** emblem in the middle of the viewport — not a repeating
tile:

- a faint technical **grid** (34 px cells, radially masked so it fades at the edges);
- a **glow** plate behind the emblem;
- the **outline** of the logo (`wireframeLayers()` — the same geometry as the mark, with
  every face stroked instead of filled, drawn in `currentColor`);
- a dashed **HUD ring** rotating every 52 s, four **corner brackets**, and a monospace
  readout: `STOCKPILOT // SMART INVENTORY SYSTEM`;
- a slow **scanline** sweeping down the viewport every 13 s.

It is `position: fixed; inset: 0` with `place-items: center`, `pointer-events: none`,
`aria-hidden`, stacked at `z-index: 2` — above the content, below modals (`50`) and toasts
(`100`) — so it never blocks the UI.

Ink and strength are CSS-only: `--cyber-ink` / `--cyber-opacity` are `#4c8df6` at `8.5 %`
with `mix-blend-mode: screen` on the dark theme, and `#1e58ce` at `7 %` with `multiply` on
the light theme. The emblem box is `--cyber-size` (`clamp(220px, 34vmin, 460px)`), set from
`BRAND.watermark.size` in React.

Rotation, the scanline and the grid motion are all disabled under
`prefers-reduced-motion`, and the whole layer is hidden when printing.

## Generating the files

```bash
npm run build:logo     # writes public/*.svg (and PNG icons when resvg is present)
npm run build:all      # build:logo + vite build + worker bundle
```

`public/` holds the generated, committed assets: `logo.svg` (mark on its plate),
`logo-mark.svg` (transparent), `logo-full.svg` (horizontal lockup), `favicon.svg`,
`app-icon.svg` (plate fills the square), `mark-wireframe.svg` (the watermark emblem) and
the PNG icons.

Rasterising PNGs needs a renderer, which is deliberately **not** a project dependency:

```bash
npm install --no-save @resvg/resvg-js && npm run build:logo
```

Without it the script regenerates the SVGs and leaves the committed PNGs alone.

## Changing the art

Edit `src/brand-art.js` (geometry, colours, HUD metrics), run `npm run build:logo`, then
`npm run verify:ui` — the suite asserts that every generated file in `public/` is
byte-identical to what `brand-art.js` produces, so the two can never drift apart.

## Product images

Each product gets an image in every list, card, detail panel and report:

- **Generated artwork** (`src/product-art.js`) is the default and the fallback — a
  two-tone gradient from the product's *category family*, a category glyph and a
  monogram derived from the name, with the tone rotating deterministically per SKU. The
  module is the single source of truth: React (`src/components/ProductImage.jsx`), the
  Worker's PDF gallery (`worker/report-pdf.js`, drawn as vector paths with pdf-lib) and
  anything else read the same constants, so a product cannot look different in two places.
- **A real photo** replaces the artwork when the product carries one — either an uploaded
  file (`image_data`, base64 in D1, served by `GET /api/products/:id/image`) or a pasted
  `https://` link (`image_url`). The form downscales a picked file to a 512 px JPEG before
  sending; only PNG, JPEG and WebP are accepted and the Worker enforces the format and the
  256 KB cap. Photos win over artwork in the UI, in the CSV export (absolute URL) and in
  the PDF gallery, which embeds them as image objects.

`<ProductImage>` takes a URL when there is one and falls back to the artwork tile on a
failed load, so a broken photo never leaves a hole in the interface.

## Machine-checked brand contract (part of `npm run verify:ui`)

- the sidebar lockup, all five page titles, the modal header, the empty state, the loading
  state, the sidebar credit and the page footer each render the mark, and the wordmark
  splits into `STOCK` / `PILOT` with the tagline beneath;
- exactly **one** watermark layer exists, holding a single centred emblem drawn from the
  same geometry as the logo, in `currentColor`, with ring, four brackets, readout, glow,
  grid and scanline present, and `aria-hidden`;
- `public/logo.svg`, `logo-mark.svg`, `favicon.svg` and `logo-full.svg` match
  `src/brand-art.js` exactly, and the icon/wireframe files carry the same artwork;
- the Worker serves `favicon.svg` as `image/svg+xml`, `apple-touch-icon.png` as
  `image/png` and `manifest.webmanifest` as `application/manifest+json`;
- the stylesheet keeps the watermark fixed, centred, overscanned by the grid and
  non-interactive, keeps the theme ink variables and blend modes, disables the ring and
  scanline under reduced motion, and hides the watermark when printing.

What is *not* machine-checked: the rendered look (blur, blend modes, grid fade, animation
easing) and the wordmark's font — no CSS engine exists in jsdom and no fonts exist in the
rasteriser used for proofing. Those are checked by eye in the live preview.
