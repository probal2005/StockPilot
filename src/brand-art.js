/* ==========================================================================
   StockPilot brand art — the single source of truth for the logo.

   Faithful vector rebuild of the supplied brand sheet: an isometric crate with
   a barcode label, three rising bars, a paper plane flying out of it and an
   orbital swoosh wrapping the whole thing.

   Nothing here imports React or touches the DOM, so the same geometry feeds:
     • src/brand.jsx            → inline React <svg> used across the UI
     • scripts/build-logo.mjs   → public/*.svg (+ PNG app icons when resvg is
                                  available) written to disk at build time
   ========================================================================== */

export const BRAND = {
  name: 'StockPilot',
  nameParts: ['STOCK', 'PILOT'],
  tagline: 'SMART INVENTORY SYSTEM',
  product: 'Smart Inventory Management System',
  description: 'Product catalogue, stock movements, low-stock alerts and inventory analytics.',
  colors: {
    navy: '#0A2A63', // crate left face, plane, "STOCK"
    navy2: '#16407C', // crate right face, plane wing
    blue: '#2E6FE3', // lid, middle bar, orbit
    blue2: '#4C8DF6', // bright lid half + tallest bar
    blue3: '#2059BC', // shortest bar
    orbit: '#1E58CE',
    white: '#FFFFFF',
    chip: '#F7FAFF', // the light plate the mark always sits on
  },
  watermark: {
    /* Cyber emblem in the middle of the viewport: ink + strength per theme. */
    size: 'clamp(220px, 34vmin, 460px)',
    opacity: { dark: 0.085, light: 0.07 },
  },
}

/* --------------------------------------------------------------- geometry -- */

export const VIEWBOX = '0 0 128 128'

const L = [26, 56]
const TP = [62, 42]
const RP = [98, 56]
const BP = [62, 70]
const H = 34 // crate body height

const poly = (pts) => `M${pts.map((p) => `${p[0]} ${p[1]}`).join(' L')} Z`
const line = (a, b) => `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`
const down = (p) => [p[0], p[1] + H]

/* Tapered orbit: a crescent between two concentric rotated ellipses. */
export function orbitPath({
  cx, cy, rx, ry, rot, a0, a1, width, seg = 48, fullA0 = a0, fullA1 = a1,
}) {
  const rad = (d) => (d * Math.PI) / 180
  const cs = Math.cos(rad(rot))
  const sn = Math.sin(rad(rot))
  const at = (deg, grow) => {
    const t = rad(deg)
    const x = (rx + grow) * Math.cos(t)
    const y = (ry + grow) * Math.sin(t)
    return [cx + x * cs - y * sn, cy + x * sn + y * cs]
  }
  const outer = []
  const inner = []
  for (let i = 0; i <= seg; i += 1) {
    const deg = a0 + (i / seg) * (a1 - a0)
    const ft = Math.min(1, Math.max(0, (deg - fullA0) / (fullA1 - fullA0)))
    const w = ((width / 2) * Math.sin(Math.PI * ft)) ** 1
    outer.push(at(deg, w))
    inner.push(at(deg, -w))
  }
  const pt = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`
  return outer.map((p, i) => `${i ? 'L' : 'M'}${pt(p)}`).join(' ')
    + ' ' + inner.reverse().map((p) => `L${pt(p)}`).join(' ') + ' Z'
}

const ORBIT = { cx: 60, cy: 86, rx: 46, ry: 28, rot: -14, a0: 198, a1: 372, width: 6.5 }
/* Base rects for the rising bars — the crate lid hides their bottoms. */
const barRect = (cx, w, top, base = 62) => poly([[cx - w / 2, top], [cx + w / 2, top], [cx + w / 2, base], [cx - w / 2, base]])

const labelU = [BP[0] - L[0], BP[1] - L[1]]
const labelO = [L[0] + labelU[0] * 0.16, L[1] + labelU[1] * 0.16]
const onFace = (a, b) => [labelO[0] + labelU[0] * a, labelO[1] + labelU[1] * a + H * b]

const PLANE = { nose: [115, 20], wing: [80, 34], fold: [99, 42], keel: [92, 58] }

export const MARK = {
  viewBox: VIEWBOX,
  /* The light plate the mark is printed on (transparent by default). */
  chip: { x: 3, y: 3, width: 122, height: 122, rx: 27 },
  crate: {
    lidLeft: poly([TP, L, BP]),
    lidRight: poly([TP, BP, RP]),
    left: poly([L, BP, down(BP), down(L)]),
    right: poly([BP, RP, down(RP), down(BP)]),
  },
  /* Hairlines that keep the crate's faces legible after the fills meet. */
  seams: [line(L, BP), line(BP, RP), line(TP, BP), line(L, down(L)), line(BP, down(BP)), line(RP, down(RP))],
  bars: [
    { d: barRect(46, 9, 44), tone: 'blue3' },
    { d: barRect(58, 10, 35), tone: 'blue' },
    { d: barRect(70, 11, 26), tone: 'blue2' },
  ],
  plane: {
    wing: poly([PLANE.nose, PLANE.wing, PLANE.fold]),
    keel: poly([PLANE.nose, PLANE.fold, PLANE.keel]),
    fold: line(PLANE.nose, PLANE.fold),
  },
  flight: 'M96 54 C101 50 100 47 102 44',
  label: {
    quad: poly([onFace(0, 0), onFace(0.36, 0), onFace(0.36, 0.46), onFace(0, 0.46)]),
    bars: [0.07, 0.14, 0.21, 0.28].map((a) =>
      poly([onFace(a, 0.1), onFace(a + 0.028, 0.1), onFace(a + 0.028, 0.36), onFace(a, 0.36)])),
  },
  orbit: {
    full: orbitPath(ORBIT),
    front: orbitPath({ ...ORBIT, a0: 222, a1: 264, seg: 16 }), // the part that wraps in front
  },
}

/* ------------------------------------------------------------ svg strings -- */

/**
 * Paint order matters: orbit → bars → plane → crate → label → wrapping orbit.
 * `ink` swaps the whole mark to a single colour (used by the watermark).
 */
export const markLayers = () => {
  return [
    { d: MARK.orbit.full, tone: 'orbit' },
    ...MARK.bars.map((b) => ({ d: b.d, tone: b.tone })),
    { d: MARK.flight, tone: 'navy', stroke: 1.5 },
    { d: MARK.plane.wing, tone: 'navy2' },
    { d: MARK.plane.keel, tone: 'navy' },
    { d: MARK.crate.lidLeft, tone: 'blue' },
    { d: MARK.crate.lidRight, tone: 'blue2' },
    { d: MARK.crate.left, tone: 'navy' },
    { d: MARK.crate.right, tone: 'navy2' },
    ...MARK.seams.map((d) => ({ d, tone: 'white', stroke: 2 })),
    { d: MARK.label.quad, tone: 'white' },
    ...MARK.label.bars.map((d) => ({ d, tone: 'navy' })),
    { d: MARK.orbit.front, tone: 'orbit' },
  ]
}

const layerSvg = (l, ink) => {
  const color = ink || BRAND.colors[l.tone]
  return l.stroke
    ? `<path d="${l.d}" fill="none" stroke="${color}" stroke-width="${l.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${l.d}" fill="${color}"/>`
}

const chipSvg = ({ x, y, width, height, rx }) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${BRAND.colors.chip}"/>`

/** The mark as a standalone SVG string. `chip: true` prints it on its light plate. */
export function markSvg({ size = 128, title = BRAND.name, chip = false, id = 'sp' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}" role="img" aria-label="${title}">`
    + (chip ? chipSvg(MARK.chip) : '')
    + markLayers().map((l) => layerSvg(l)).join('')
    + `</svg>`
}

/**
 * Outline view of the mark: the same geometry with every face stroked instead
 * of filled. This is what the cyber watermark paints, so the emblem and the
 * logo can never diverge.
 */
export const wireframeLayers = () => [
  MARK.crate.lidLeft, MARK.crate.lidRight, MARK.crate.left, MARK.crate.right,
  ...MARK.bars.map((b) => b.d),
  MARK.plane.wing, MARK.plane.keel, MARK.label.quad,
  ...MARK.label.bars,
  MARK.orbit.full,
].map((d) => ({ d, stroke: 2.4 }))

/** The outline mark as a standalone SVG file. */
export function wireframeSvg({ size = 128, ink = BRAND.colors.blue2 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">`
    + wireframeLayers().map((l) => `<path d="${l.d}" fill="none" stroke="${ink}" stroke-width="${l.stroke}" stroke-linejoin="round"/>`).join('')
    + `</svg>`
}

/* Cyber watermark: one emblem in the middle of the viewport, HUD furniture
   around it. Sizes are in the emblem's own units so CSS can scale the whole
   thing with one variable. */
export const HUD = {
  grid: 34, // px between grid lines
  ring: 200, // dashed ring diameter, % of the emblem box
  brackets: 4,
  label: `${BRAND.name.toUpperCase()} // ${BRAND.tagline}`,
}

/** Horizontal lockup: mark + two-tone wordmark + tagline rule. */
export function fullLogoSvg({ height = 128, id = 'sp-full' } = {}) {
  const pad = 6
  const markSize = height
  const width = Math.round(height * 3.7)
  const textX = markSize + 14
  const c = BRAND.colors
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${BRAND.name}">`
    + `<g transform="translate(0 ${pad}) scale(${((height - pad * 2) / 128).toFixed(4)})">`
    + chipSvg(MARK.chip)
    + markLayers().map((l) => layerSvg(l)).join('')
    + `</g>`
    + `<text x="${textX}" y="${height * 0.52}" font-family="Archivo Black, Montserrat, 'Segoe UI', system-ui, sans-serif" font-size="${Math.round(height * 0.36)}" font-weight="800" letter-spacing="1.5">`
    + `<tspan fill="${c.navy}">${BRAND.nameParts[0]}</tspan><tspan fill="${c.blue}">${BRAND.nameParts[1]}</tspan></text>`
    + `<text x="${textX}" y="${height * 0.78}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${Math.round(height * 0.09)}" letter-spacing="${(height * 0.042).toFixed(2)}" fill="${c.navy}" opacity="0.72">${BRAND.tagline}</text>`
    + `</svg>`
}
