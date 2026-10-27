/* ==========================================================================
   PDF report — a decorated, multi-page inventory intelligence document built
   from the live report endpoints. Runs entirely inside the Worker: pdf-lib is
   pure JavaScript, the brand art is the same geometry module the app renders
   (src/brand-art.js), and nothing is fetched from a third party at runtime.

   Layout engine: a small flow object (`Sheet`) that owns the current page, a
   cursor that walks down it, automatic page breaks, and the primitives the
   report is composed from — panels, KPI tiles, tables, bars, a gauge, a
   heatmap and vector column charts.
   ========================================================================== */
import { PDFDocument, LineCapStyle, LineJoinStyle, StandardFonts, rgb, degrees } from 'pdf-lib'
import { BRAND, MARK, markLayers } from '../src/brand-art.js'
import { GLYPH_STROKE, artFor } from '../src/product-art.js'
import { alerts, reportActivity, reportHealth, reportSummary, reportValuation } from './insights.js'
import { base64ToBytes } from './lib.js'
import { listMovements } from './stock.js'
import { badRequest } from './lib.js'

/* -------------------------------------------------------------- document -- */

export const PAGE = { width: 595.28, height: 841.89 } // A4 portrait, points
const M = { x: 42, top: 46, bottom: 54 }

/** A4 landscape — used for the wide analytics pages. */
const LANDSCAPE = { width: 841.89, height: 595.28 }

const palette = {
  navy: '#0A2A63', navy2: '#16407C', blue: '#2E6FE3', blue2: '#4C8DF6', blue3: '#2059BC',
  orbit: '#1E58CE', chip: '#F7FAFF',
  ink: '#0B1424', slate: '#33415C', muted: '#64748B', faint: '#94A3B8',
  line: '#DFE6F3', soft: '#F4F7FD', softer: '#FAFCFF', white: '#FFFFFF',
  indigo: '#6366F1', cyan: '#06B6D4', violet: '#7C3AED',
  good: '#059669', goodSoft: '#E6F6F0', warn: '#D97706', warnSoft: '#FDF4E5',
  danger: '#E11D48', dangerSoft: '#FDE9EE', info: '#2563EB', infoSoft: '#E8F0FE',
}

const rgbOf = (value) => {
  const h = String(value).replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}
const mix = (a, b, t) => {
  const pa = parseInt(String(a).replace('#', ''), 16)
  const pb = parseInt(String(b).replace('#', ''), 16)
  const ch = (shift) => Math.round((((pa >> shift) & 255) * (1 - t)) + (((pb >> shift) & 255) * t))
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`
}

/* pdf-lib's standard fonts are WinAnsi: anything outside that table throws. */
const WINANSI_EXTRA = '°·—–’‘“”…€£¥©®™•×÷±§¶'
const SYMBOL_MAP = {
  '↓': 'in', '↑': 'out', '→': '->', '←': '<-', '≈': '~', '≥': '>=', '≤': '<=',
  '·': '·', '•': '•', '⚖': '', '↻': '', '⏳': '', '◆': '', '▸': '', '▲': '^', '▼': 'v',
}
export function sanitize(value) {
  const text = String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, ' - ').replace(/\u2013/g, '-')
  let out = ''
  for (const ch of text) {
    if (SYMBOL_MAP[ch] !== undefined) { out += SYMBOL_MAP[ch]; continue }
    const code = ch.codePointAt(0)
    if (ch === '\n' || ch === '\t' || code === 32) { out += ' '; continue }
    // strip emoji and anything WinAnsi cannot represent
    if (code < 32) continue
    if (code >= 32 && code <= 126) { out += ch; continue }
    if (WINANSI_EXTRA.includes(ch)) { out += ch; continue }
    if (code >= 0xa0 && code <= 0xff) { out += ch; continue }
    out += ''
  }
  return out.replace(/\s+/g, ' ').trim()
}

/* --------------------------------------------------------------- paths ----- */

const num = (n) => Math.round(n * 100) / 100
const polyPath = (points) => `M${points.map((p) => `${num(p[0])} ${num(p[1])}`).join(' L')} Z`
/**
 * Rounded-rectangle path. The box is normalised (any corner order, negative
 * heights allowed) and the corner radius is always positive — a negative radius
 * silently turns the outline into an hourglass.
 */
export function roundedPath(x, y, w, h, r) {
  const x0 = Math.min(x, x + w)
  const x1 = Math.max(x, x + w)
  const y0 = Math.min(y, y + h)
  const y1 = Math.max(y, y + h)
  const rad = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2))
  const q = 0.45
  return [
    `M${num(x0 + rad)} ${num(y0)}`,
    `L${num(x1 - rad)} ${num(y0)}`,
    `C${num(x1 - rad * q)} ${num(y0)} ${num(x1)} ${num(y0 + rad * q)} ${num(x1)} ${num(y0 + rad)}`,
    `L${num(x1)} ${num(y1 - rad)}`,
    `C${num(x1)} ${num(y1 - rad * q)} ${num(x1 - rad * q)} ${num(y1)} ${num(x1 - rad)} ${num(y1)}`,
    `L${num(x0 + rad)} ${num(y1)}`,
    `C${num(x0 + rad * q)} ${num(y1)} ${num(x0)} ${num(y1 - rad * q)} ${num(x0)} ${num(y1 - rad)}`,
    `L${num(x0)} ${num(y0 + rad)}`,
    `C${num(x0)} ${num(y0 + rad * q)} ${num(x0 + rad * q)} ${num(y0)} ${num(x0 + rad)} ${num(y0)}`,
    'Z',
  ].join(' ')
}
const circlePath = (cx, cy, r, seg = 64) => {
  const pts = []
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return polyPath(pts)
}
const arcPath = (cx, cy, r, from, to, inner = null, seg = 64) => {
  const outer = []
  const back = []
  for (let i = 0; i <= seg; i += 1) {
    const a = (from + ((to - from) * i) / seg) * (Math.PI / 180)
    outer.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    if (inner) back.unshift([cx + inner * Math.cos(a), cy + inner * Math.sin(a)])
  }
  return polyPath([...outer, ...back])
}

/* ------------------------------------------------------------- formatters -- */

const nfmt = new Intl.NumberFormat('en-US')
export const nf = (n, digits = 0) => nfmt.format(Number.isFinite(Number(n)) ? Number(n) : 0)
export const money = (n) => `$${nfmt.format(Math.round((Number(n) || 0) * 100) / 100)}`
export const money2 = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const compact = (n) => {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (Math.abs(v) >= 1e4) return `$${(v / 1e3).toFixed(1)}k`
  return money(v)
}
const pct = (v, digits = 1) => `${(Number(v) || 0).toFixed(digits)}%`
const dayLabel = (iso) => {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
const stamp = (iso) => {
  const d = iso ? new Date(iso) : new Date()
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
}

const GRADE_COLOR = (grade) => ({ A: palette.good, B: palette.blue, C: palette.warn, D: palette.danger }[grade] ?? palette.blue)
const TONE = {
  ok: { fg: palette.good, bg: palette.goodSoft },
  low: { fg: palette.warn, bg: palette.warnSoft },
  out: { fg: palette.danger, bg: palette.dangerSoft },
  info: { fg: palette.info, bg: palette.infoSoft },
  neutral: { fg: palette.slate, bg: palette.soft },
}
export const STATUS_LABEL = { ok: 'In stock', low: 'Low stock', out: 'Out of stock' }

/* ----------------------------------------------------------------- layout -- */

/**
 * Flow object: owns the current page, a cursor walking down it, automatic page
 * breaks and every drawing primitive the report is built from.
 */
class Sheet {
  constructor(doc, fonts, meta) {
    this.doc = doc
    this.fonts = fonts
    this.meta = meta
    this.page = null
    this.y = 0
    this.index = 0
    this.section = ''
  }

  get size() { return this.page ? this.page.getSize() : PAGE }
  get contentWidth() { return this.size.width - M.x * 2 }
  get bottom() { return M.bottom }

  /* -- pages -------------------------------------------------------------- */

  newPage({ title = '', kicker = '', landscape = false, dark = false } = {}) {
    this.index += 1
    this.page = this.doc.addPage(landscape ? [LANDSCAPE.width, LANDSCAPE.height] : [PAGE.width, PAGE.height])
    this.section = title
    // content starts below the header furniture, never on top of it
    this.y = this.size.height - M.top - (title || kicker ? 32 : 0)
    if (dark) this.paintBackground()
    else this.drawHeader(title, kicker)
    return this.page
  }

  /** Rich, low-opacity background used on the cover. */
  paintBackground() {
    const { width, height } = this.size
    this.page.drawRectangle({ x: 0, y: 0, width, height, color: rgbOf(palette.paper ?? '#FBFCFF') })
    this.gradient({ x: 0, y: height - 268, width, height: 268, from: '#123A7A', to: palette.blue, vertical: false })
    this.gradient({ x: 0, y: height - 268, width, height: 268, from: '#FFFFFF', to: palette.blue2, vertical: true, steps: 70, opacity: 0.14 })
    for (let i = 0; i < 34; i += 1) {
      const t = i / 33
      this.page.drawLine({
        start: { x: width * t, y: height - 268 },
        end: { x: width * 0.3 + width * 0.62 * t, y: height - 268 * (0.3 + 0.7 * t) },
        thickness: 0.4, color: rgbOf('#FFFFFF'), opacity: 0.06,
      })
    }
    this.page.drawCircle({ x: width - 60, y: height - 200, size: 146, color: rgbOf(palette.blue2), opacity: 0.12 })
    this.page.drawCircle({ x: width - 40, y: height - 250, size: 60, color: rgbOf('#FFFFFF'), opacity: 0.10 })
    this.y = height - 268 - 26
  }

  drawHeader(title = '', kicker = '') {
    const { width, height } = this.size
    this.page.drawRectangle({ x: 0, y: height - 3, width, height: 3, color: rgbOf(palette.navy) })
    this.gradient({ x: 0, y: height - 3, width, height: 3, from: palette.blue, to: palette.cyan, steps: 60 })
    if (!title) return
    const top = height - 24
    this.mark(M.x, top, 15)
    this.text(title, M.x + 21, top - 10, { style: 'bold', size: 11, color: palette.ink })
    if (kicker) this.text(kicker, M.x + 21, top - 20, { size: 7.2, color: palette.muted })
    this.text(sanitize(this.meta.docTitle), width - M.x, top - 10, { size: 7.2, color: palette.faint, align: 'right' })
    this.text(`Report ${this.meta.id}`, width - M.x, top - 20, { size: 7.2, color: palette.faint, align: 'right' })
    this.page.drawLine({
      start: { x: M.x, y: top - 28 }, end: { x: width - M.x, y: top - 28 },
      thickness: 0.7, color: rgbOf(palette.line),
    })
  }

  /** Footer on every page: brand rule, mark, product line, page number. */
  finishFooters() {
    const pages = this.doc.getPages()
    pages.forEach((page, i) => {
      const { width } = page.getSize()
      const y = 30
      this.gradient({ page, x: M.x, y: y + 22, width: width - M.x * 2, height: 1.6, from: palette.blue, to: palette.cyan, steps: 48 })
      this.mark(M.x, y + 18, 12, page)
      this.text(`${BRAND.name} · ${BRAND.tagline}`, M.x + 17, y + 8, { size: 7, color: palette.muted, page })
      this.text(`${stamp(this.meta.generatedAt)}`, width / 2, y + 8, { size: 7, color: palette.faint, page, align: 'center' })
      this.text(`Report ${this.meta.id} · Page ${i + 1} of ${pages.length}`, width - M.x, y + 8, { size: 7, color: palette.faint, page, align: 'right' })
      page.drawLine({ start: { x: M.x, y: y + 30 }, end: { x: width - M.x, y: y + 30 }, thickness: 0.5, color: rgbOf(palette.line) })
    })
  }

  /* -- typography --------------------------------------------------------- */

  font(style = 'reg') { return this.fonts[style] }

  measure(text, { style = 'reg', size = 9 } = {}) {
    return this.font(style).widthOfTextAtSize(sanitize(text), size)
  }

  wrap(text, maxWidth, { style = 'reg', size = 9 } = {}) {
    const clean = sanitize(text)
    if (!clean) return []
    const words = clean.split(' ')
    const lines = []
    let line = ''
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word
      if (this.measure(probe, { style, size }) <= maxWidth || !line) line = probe
      else { lines.push(line); line = word }
    }
    if (line) lines.push(line)
    return lines
  }

  fit(text, maxWidth, { style = 'reg', size = 9 } = {}) {
    const clean = sanitize(text)
    if (this.measure(clean, { style, size }) <= maxWidth) return clean
    let out = clean
    while (out.length > 1 && this.measure(`${out}...`, { style, size }) > maxWidth) out = out.slice(0, -1)
    return `${out}...`
  }

  text(value, x, y, { style = 'reg', size = 9, color = palette.ink, align = 'left', opacity = 1, page = null }) {
    const clean = sanitize(value)
    if (clean === '') return
    const target = page ?? this.page
    const width = this.measure(clean, { style, size })
    let px = x
    if (align === 'right') px = x - width
    else if (align === 'center') px = x - width / 2
    target.drawText(clean, { x: px, y, size, font: this.font(style), color: rgbOf(color), opacity })
  }

  /** Letter-spaced caps, used for kickers and section labels. */
  tracked(value, x, y, { size = 7.5, color = palette.muted, align = 'left', spacing = 1.1, page = null, style = 'bold' } = {}) {
    const clean = sanitize(value)
    const target = page ?? this.page
    const chars = [...clean]
    const total = chars.reduce((w, ch) => w + this.measure(ch, { style, size }) + spacing, 0) - (chars.length ? spacing : 0)
    let px = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x
    for (const ch of chars) {
      target.drawText(ch, { x: px, y, size, font: this.font(style), color: rgbOf(color) })
      px += this.measure(ch, { style, size }) + spacing
    }
    return total
  }

  para(value, x, y, maxWidth, { style = 'reg', size = 8.6, color = palette.slate, lineHeight = 1.42 } = {}) {
    const lines = this.wrap(value, maxWidth, { style, size })
    lines.forEach((line, i) => this.text(line, x, y - i * size * lineHeight, { style, size, color }))
    return lines.length * size * lineHeight
  }

  /* -- primitives --------------------------------------------------------- */

  /** Approximates a linear gradient with thin strips (pdf-lib has no shading). */
  gradient({ x, y, width, height, from, to, steps = 90, vertical = false, opacity = 1, page = null }) {
    const target = page ?? this.page
    for (let i = 0; i < steps; i += 1) {
      const t = i / (steps - 1)
      const color = rgbOf(mix(from, to, t))
      if (vertical) {
        target.drawRectangle({ x, y: y + (height * i) / steps, width, height: height / steps + 0.5, color, opacity })
      } else {
        target.drawRectangle({ x: x + (width * i) / steps, y, width: width / steps + 0.5, height, color, opacity })
      }
    }
  }

  /**
   * Rounded panel. `y` is the BOTTOM edge and the box grows upward, matching the
   * rest of this file's PDF-space coordinates. (pdf-lib's drawSvgPath flips the
   * SVG y axis, so the translate sits at the top of the box.)
   */
  rounded({ x, y, width, height, radius = 10, fill = palette.white, border = palette.line, borderWidth = 0.7, opacity = 1, page = null }) {
    const target = page ?? this.page
    target.drawSvgPath(roundedPath(0, 0, width, height, radius), {
      x, y: y + height, color: rgbOf(fill), opacity,
      ...(border ? { borderColor: rgbOf(border), borderWidth } : {}),
    })
  }

  /**
   * The StockPilot mark, drawn from the same geometry module the app renders.
   * `y` is the TOP edge of the mark box (SVG coordinates grow downward).
   */
  mark(x, y, size, page = null, { chip = true } = {}) {
    const target = page ?? this.page
    const scale = size / 128
    if (chip) {
      target.drawSvgPath(roundedPath(MARK.chip.x, MARK.chip.y, MARK.chip.width, MARK.chip.height, MARK.chip.rx), {
        x, y, scale, color: rgbOf(BRAND.colors.chip),
      })
    }
    for (const layer of markLayers()) {
      const color = rgbOf(BRAND.colors[layer.tone])
      if (layer.stroke) {
        target.drawSvgPath(layer.d, {
          x, y, scale, borderColor: color, borderWidth: layer.stroke * scale,
          borderLineCap: LineCapStyle.Round, borderLineJoin: LineJoinStyle.Round,
        })
      } else {
        target.drawSvgPath(layer.d, { x, y, scale, color })
      }
    }
  }

  /**
   * A product tile: the same artwork the app renders, drawn with the shared
   * geometry from src/product-art.js — flat tone, category glyph, soft border.
   */
  artTile({ x, y, size, product, glyphScale = 1 }) {
    const art = artFor(product)
    const mid = mix(art.tone.from, art.tone.to, 0.4)
    const edge = mix(art.tone.from, art.tone.to, 0.95)
    const radius = size * 0.26
    this.rounded({ x, y, width: size, height: size, radius, fill: mid, border: null })
    this.page.drawSvgPath(roundedPath(0, 0, size, size, radius), {
      x, y: y + size, borderColor: rgbOf(edge), borderWidth: 0.8,
    })
    const scale = (size / 24) * glyphScale
    const inset = (size - scale * 24) / 2
    this.page.drawSvgPath(art.glyph, {
      x: x + inset, y: y + size - inset, scale,
      borderColor: rgbOf('#FFFFFF'), borderWidth: GLYPH_STROKE * scale,
      borderLineCap: LineCapStyle.Round, borderLineJoin: LineJoinStyle.Round,
      borderOpacity: 0.95,
    })
    return art
  }

  /** A stored photo, framed in the same tone the generated artwork would use. */
  photoTile({ x, y, size, image, product }) {
    const art = artFor(product)
    const inset = size * 0.06
    const inner = size - inset * 2
    this.rounded({ x, y, width: size, height: size, radius: size * 0.18, fill: mix(art.tone.from, art.tone.to, 0.5), border: null })
    this.page.drawImage(image, { x: x + inset, y: y + inset, width: inner, height: inner })
    return art
  }

  wordmark(x, y, { size = 20, align = 'left' } = {}) {
    const a = BRAND.nameParts[0]
    const b = BRAND.nameParts[1]
    const wa = this.measure(a, { style: 'bold', size })
    const total = wa + this.measure(b, { style: 'bold', size })
    const sx = align === 'right' ? x - total : x
    this.page.drawText(a, { x: sx + 1.2, y, size, font: this.fonts.bold, color: rgbOf(palette.navy) })
    this.page.drawText(b, { x: sx + wa + 1.2, y, size, font: this.fonts.bold, color: rgbOf(palette.blue) })
    return total
  }

  chip(value, x, y, { tone = 'neutral', size = 7.4, padX = 6, height = 13.5 } = {}) {
    const t = TONE[tone] ?? TONE.neutral
    const label = sanitize(value)
    const w = this.measure(label, { style: 'bold', size }) + padX * 2
    this.rounded({ x, y, width: w, height, radius: height / 2, fill: t.bg, border: t.bg })
    this.text(label, x + w / 2, y + height / 2 - size * 0.34, { style: 'bold', size, color: t.fg, align: 'center' })
    return w
  }

  pill(value, x, y, w, { tone = 'info', size = 7.6, align = 'center' } = {}) {
    const t = TONE[tone] ?? TONE.info
    this.rounded({ x, y, width: w, height: 15, radius: 7.5, fill: t.bg, border: t.bg })
    this.text(value, align === 'center' ? x + w / 2 : x + 7, y + 15 / 2 - size * 0.34, { style: 'bold', size, color: t.fg, align })
  }

  sectionHead(label, hint = '') {
    this.need(34)
    const { width } = this.size
    this.page.drawRectangle({ x: M.x, y: this.y - 1.5, width: 16, height: 2.4, color: rgbOf(palette.blue) })
    this.tracked(label, M.x + 22, this.y + 3.6, { size: 8.2, color: palette.navy, spacing: 1.4 })
    if (hint) this.text(hint, width - M.x, this.y + 3, { size: 7.6, color: palette.faint, align: 'right' })
    this.y -= 16
  }

  /**
   * White card with a titled head. The caller passes `content` — the height its
   * own drawing needs — and the card adds the head and padding, so a card can
   * never be shorter than what is painted inside it.
   */
  card({ x = M.x, width = this.contentWidth, content = 0, title = '', subtitle = '', accent = palette.blue, draw, tone = palette.white, gap = 13 }) {
    const height = this.cardHeight({ title, subtitle, content })
    // Never let a card run into the footer: continue on a fresh page instead.
    if (height < this.size.height - M.top - M.bottom - 60 && this.y - height - 6 < this.bottom + 10) {
      this.newPage({ title: this.section, kicker: 'continued' })
    }
    const top = this.y
    this.rounded({ x, y: top - height, width, height, radius: 12, fill: tone })
    if (title) this.page.drawRectangle({ x: x + 12, y: top - 3.4, width: 26, height: 2, color: rgbOf(accent), opacity: 0.9 })
    let inner = top - (title ? 16 : 14)
    if (title) {
      this.text(title, x + 14, inner, { style: 'bold', size: 10, color: palette.ink })
      inner -= 11
      if (subtitle) {
        const h = this.para(subtitle, x + 14, inner, width - 28, { size: 7.6, color: palette.muted })
        inner -= h - 2
      }
    }
    draw?.({ x: x + 14, y: inner, width: width - 28, top: inner })
    this.y = top - height - gap
  }

  /** Height a card needs for its head plus `content` points of body. */
  cardHeight({ title = '', subtitle = '', content = 0 }) {
    return (title ? 18 : 8) + (subtitle ? 15 : 0) + content + 13
  }

  /** Heights the page composers hand to card(): one formula per component. */
  tableHeight(rows, rowHeight = 15.5) { return 15 + rows * rowHeight }
  barsHeight(rows, rowHeight = 19) { return rows * rowHeight }
  statsHeight(items, columns = 4, rowHeight = 38) { return Math.ceil(items.length / columns) * rowHeight }
  metersHeight(count, step = 32) { return count * step }

  /** Stacked label/value rows used inside cards. */
  stats(items, { x, y, width, columns = 4, rowHeight = 34, valueSize = 12, gap = 8 }) {
    const colWidth = (width - gap * (columns - 1)) / columns
    items.forEach((item, i) => {
      const cx = x + (i % columns) * (colWidth + gap)
      const cy = y - Math.floor(i / columns) * rowHeight
      this.text(item.label, cx, cy - 6, { style: 'bold', size: 7, color: palette.muted })
      this.text(item.value, cx, cy - 21, { style: 'bold', size: valueSize, color: item.color ?? palette.ink })
      if (item.hint) this.text(item.hint, cx, cy - 30, { size: 6.8, color: palette.faint })
    })
    return Math.ceil(items.length / columns) * rowHeight
  }

  table({ x, y, width, columns, rows, rowHeight = 15.5, headerHeight = 16, zebra = true, chipColumn = null }) {
    const total = columns.reduce((s, c) => s + c.width, 0)
    const widths = columns.map((c) => (c.width / total) * width)
    const xs = []
    let cursor = x
    for (const w of widths) { xs.push(cursor); cursor += w }

    this.page.drawRectangle({ x, y: y - headerHeight + 4, width, height: headerHeight, color: rgbOf(palette.navy), })
    if (chipColumn !== null) { /* keep signature simple */ }
    columns.forEach((c, i) => {
      const cx = c.align === 'right' ? xs[i] + widths[i] - 6 : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + 3
      this.text(c.label, cx, y - headerHeight + 9.6, { style: 'bold', size: this.measure(c.label, { style: 'bold', size: 7.2 }) > widths[i] - 6 ? 6.4 : 7.2, color: palette.white, align: c.align ?? 'left' })
    })
    let ty = y - headerHeight
    rows.forEach((row, r) => {
      if (zebra && r % 2 === 1) this.page.drawRectangle({ x, y: ty - rowHeight + 4, width, height: rowHeight, color: rgbOf(palette.soft) })
      this.page.drawLine({ start: { x, y: ty - rowHeight + 4 }, end: { x: x + width, y: ty - rowHeight + 4 }, thickness: 0.4, color: rgbOf(palette.line) })
      columns.forEach((c, i) => {
        const value = row[c.key]
        const cx = c.align === 'right' ? xs[i] + widths[i] - 6 : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + 3
        if (c.chip) {
          const tone = row[`${c.key}_tone`] ?? 'neutral'
          const chipH = 13.5
          this.chip(c.format ? c.format(value, row) : value, c.align === 'right' ? cx - 30 : cx + 2, ty - rowHeight / 2 - chipH / 2, { tone, height: chipH })
          return
        }
        const display = c.format ? c.format(value, row) : value
        this.text(this.fit(display, widths[i] - 8, { style: c.style ?? 'reg', size: c.size ?? 7.6 }),
          cx, ty - rowHeight / 2 - 3, { style: c.style ?? 'reg', size: c.size ?? 7.6, color: c.color ?? palette.slate, align: c.align ?? 'left' })
      })
      ty -= rowHeight
    })
    return headerHeight + rows.length * rowHeight
  }

  barRow({ x, y, width, label, value, max, color = palette.blue, caption = '', valueText = '', height = 7 }) {
    this.text(this.fit(label, width * 0.42, { size: 7.6 }), x, y + 1, { size: 7.6, color: palette.slate })
    const barX = x + width * 0.44
    const barW = width * 0.4
    this.rounded({ x: barX, y: y - 1, width: barW, height, radius: height / 2, fill: palette.soft, border: null })
    const frac = max > 0 ? Math.max(0.012, Math.min(1, value / max)) : 0
    const fillW = barW * frac
    this.rounded({ x: barX, y: y - 1, width: fillW, height, radius: height / 2, fill: color, border: null })
    this.text(valueText, x + width, y + 1, { style: 'bold', size: 7.8, color: palette.ink, align: 'right' })
    if (caption) this.text(caption, barX + barW + 8, y + 1, { size: 6.8, color: palette.faint })
  }

  /**
   * Health dial: a 270-degree arc with inner ticks, the score in the middle and
   * a grade chip plus caption under it. Drawn inside the box the caller provides
   * (x, y = bottom-left, width, height) so it can never spill over its plate.
   */
  dial({ x, y, width, height, value = 0, grade = 'B', caption = '' }) {
    const cx = x + width / 2
    const size = Math.min(width - 18, height - 52)
    const r = size / 2
    const cy = y + height - 24 - r
    const thickness = Math.max(6.5, size * 0.098)
    const ring = r - thickness / 2
    const start = 135
    const sweep = 270
    const frac = Math.max(0, Math.min(1, value / 100))
    this.page.drawSvgPath(arcPath(0, 0, ring + thickness / 2, start, start + sweep, ring - thickness / 2, 96), {
      x: cx, y: cy, color: rgbOf(palette.soft),
    })
    if (frac > 0) {
      this.page.drawSvgPath(arcPath(0, 0, ring + thickness / 2, start, start + sweep * frac, ring - thickness / 2, 96), {
        x: cx, y: cy, color: rgbOf(GRADE_COLOR(grade)),
      })
    }
    // ticks sit inside the ring so they read as a scale, not a sunburst
    const r1 = ring - thickness / 2 - 1.5
    for (let i = 0; i <= 24; i += 1) {
      const a = ((start + (sweep * i) / 24) * Math.PI) / 180
      const on = i / 24 <= frac + 0.001
      const len = i % 6 === 0 ? 6 : 4
      this.page.drawLine({
        start: { x: cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r1 },
        end: { x: cx + Math.cos(a) * (r1 - len), y: cy + Math.sin(a) * (r1 - len) },
        thickness: i % 6 === 0 ? 0.9 : 0.6, color: rgbOf(on ? GRADE_COLOR(grade) : palette.line),
      })
    }
    this.text(String(Math.round(value)), cx, cy - size * 0.08, { style: 'bold', size: size * 0.42, color: palette.ink, align: 'center' })
    this.text('out of 100', cx, cy - size * 0.27, { size: 7, color: palette.faint, align: 'center' })
    // grade chip + caption below the arc, clear of everything
    const label = `GRADE ${grade}`
    const chipW = this.measure(label, { style: 'bold', size: 7.6 }) + 14
    this.chip(label, cx - chipW / 2, y + 24, {
      tone: grade === 'A' ? 'ok' : grade === 'D' ? 'out' : grade === 'C' ? 'low' : 'info', size: 7.6, padX: 7,
    })
    this.text(caption, cx, y + 12, { size: 7.2, color: palette.muted, align: 'center' })
  }

  meter({ x, y, width, label, value, weight, hint, color }) {
    this.text(label, x, y, { style: 'bold', size: 8, color: palette.ink })
    this.text(`${Math.round(value)}/100`, x + width, y, { style: 'bold', size: 8, color: color ?? palette.ink, align: 'right' })
    const trackY = y - 9
    this.rounded({ x, y: trackY, width, height: 6, radius: 3, fill: palette.soft, border: null })
    this.rounded({ x, y: trackY, width: Math.max(3, (width * Math.max(0, Math.min(100, value))) / 100), height: 6, radius: 3, fill: color ?? palette.blue, border: null })
    const hintText = [weight ? `${Math.round(weight * 100)}% weight` : '', hint].filter(Boolean).join(' · ')
    if (hintText) this.text(this.fit(hintText, width, { size: 6.8 }), x, trackY - 10, { size: 6.8, color: palette.muted })
    return 30
  }

  heat({ x, y, cell = 13, gap = 2.4, weeks, weekdays, cells, max, label = 'units out' }) {
    const index = new Map(cells.map((c) => [`${c.week}|${c.weekday}`, c]))
    const byWeek = new Map()
    for (const c of cells) byWeek.set(c.week, c.units_out)
    weeks.forEach((week, wi) => {
      weekdays.forEach((day, di) => {
        const c = index.get(`${week}|${day.id}`)
        const v = c ? c.units_out : 0
        const t = max > 0 ? Math.min(1, v / max) : 0
        const cx = x + wi * (cell + gap)
        const cy = y - di * (cell + gap) - cell
        this.rounded({
          x: cx, y: cy, width: cell, height: cell, radius: 3,
          fill: v > 0 ? mix('#E7EFFD', palette.blue, 0.15 + t * 0.85) : palette.soft, border: null,
        })
        if (v > 0 && cell >= 12) this.text(String(Math.round(v)), cx + cell / 2, cy + cell / 2 - 2.6, { size: 5.6, color: t > 0.55 ? palette.white : palette.navy2, align: 'center' })
      })
    })
    weekdays.forEach((day, di) => this.text(day.label, x - 6, y - di * (cell + gap) - cell / 2 - 2.4, { size: 6.4, color: palette.faint, align: 'right' }))
    return weeks.length * (cell + gap)
  }

  columns({ x, y, width, height, series, keys, labelKey = 'label', axisLabels = 6 }) {
    const max = Math.max(1, ...series.flatMap((row) => keys.map((k) => Number(row[k.value]) || 0)))
    this.page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.6, color: rgbOf(palette.line) })
    for (let g = 1; g <= 3; g += 1) {
      const gy = y + (height * g) / 3
      this.page.drawLine({ start: { x, y: gy }, end: { x: x + width, y: gy }, thickness: 0.35, color: rgbOf(palette.line), opacity: 0.7 })
    }
    const slot = width / Math.max(1, series.length)
    const barW = Math.max(1.6, Math.min(7, (slot * 0.62) / keys.length))
    series.forEach((row, i) => {
      keys.forEach((k, ki) => {
        const v = Number(row[k.value]) || 0
        const h = (v / max) * height
        const bx = x + i * slot + slot / 2 - (barW * keys.length) / 2 + ki * barW
        if (h > 0) {
          this.rounded({ x: bx, y, width: barW, height: h, radius: Math.min(2, barW / 2), fill: k.color, border: null })
        }
      })
    })
    const step = Math.max(1, Math.floor(series.length / axisLabels))
    series.forEach((row, i) => {
      if (i % step !== 0 && i !== series.length - 1) return
      this.text(dayLabel(row[labelKey]), x + i * slot + slot / 2, y - 9, { size: 6, color: palette.faint, align: 'center' })
    })
    return max
  }

  hbars({ x, y, width, items, height = 120, valueFormat = (v) => nf(v) }) {
    const max = Math.max(1, ...items.map((i) => i.value))
    const rowH = Math.min(18, height / Math.max(1, items.length))
    items.forEach((item, i) => {
      const ry = y - i * rowH
      this.text(this.fit(item.label, width * 0.3, { size: 7.4 }), x, ry, { size: 7.4, color: palette.slate })
      const barX = x + width * 0.32
      const barW = width * 0.52
      this.rounded({ x: barX, y: ry - 1.5, width: barW, height: 6.6, radius: 3.3, fill: palette.soft, border: null })
      this.rounded({ x: barX, y: ry - 1.5, width: Math.max(3, (barW * item.value) / max), height: 6.6, radius: 3.3, fill: item.color ?? palette.blue, border: null })
      this.text(valueFormat(item.value), x + width, ry, { style: 'bold', size: 7.4, color: palette.ink, align: 'right' })
    })
    return items.length * rowH
  }

  legend(items, x, y) {
    let cursor = x
    for (const item of items) {
      this.page.drawRectangle({ x: cursor, y: y + 1, width: 7, height: 7, color: rgbOf(item.color) })
      this.text(item.label, cursor + 10, y + 1.6, { size: 6.8, color: palette.muted })
      cursor += 10 + this.measure(item.label, { size: 6.8 }) + 14
    }
    return cursor - x
  }

  callout({ x, y, width, tone = 'info', title, body, height = 34 }) {
    const t = TONE[tone] ?? TONE.info
    this.rounded({ x, y: y - height + 12, width, height, radius: 9, fill: t.bg, border: null })
    this.page.drawRectangle({ x, y: y - height + 12, width: 3, height, color: rgbOf(t.fg) })
    this.text(title, x + 11, y - 2, { style: 'bold', size: 8.2, color: t.fg })
    this.para(body, x + 11, y - 13, width - 20, { size: 7.4, color: palette.slate })
    return height
  }

  need(height, carry = {}) {
    if (this.y - height >= this.bottom + 8) return false
    this.newPage({ title: carry.title ?? this.section, kicker: carry.kicker ?? 'continued' })
    return true
  }

  rule(y = null, opacity = 1) {
    const yy = y ?? this.y
    this.page.drawLine({ start: { x: M.x, y: yy }, end: { x: this.size.width - M.x, y: yy }, thickness: 0.6, color: rgbOf(palette.line), opacity })
  }
}

/* ------------------------------------------------------------ data intake -- */

const reportUrl = (query) => new URL(`https://report.local/api/${query}`)
const unwrap = async (response) => (await response).json()

/** Everything the document needs, from the same handlers the API serves. */
async function collect(env, from, to) {
  const [health, activity, summary, valuation, alertDoc, ledger] = await Promise.all([
    unwrap(reportHealth(env, reportUrl(`reports/health?from=${from}&to=${to}`))),
    unwrap(reportActivity(env, reportUrl(`reports/activity?from=${from}&to=${to}`))),
    unwrap(reportSummary(env, reportUrl(`reports/summary?from=${from}&to=${to}`))),
    unwrap(reportValuation(env, reportUrl('reports/valuation'))),
    unwrap(alerts(env, reportUrl('alerts'))),
    unwrap(listMovements(env, reportUrl(`movements?from=${from}&to=${to}&limit=14`))),
  ])
  // Stored photos are read straight from D1 and embedded in the gallery; a
  // format pdf-lib cannot embed simply falls back to the generated artwork.
  const { results: photoRows } = await env.DB.prepare(
    "SELECT id, image_type, image_data FROM products WHERE image_data <> ''",
  ).all()
  const photos = new Map()
  for (const row of photoRows ?? []) {
    if (!['image/jpeg', 'image/png'].includes(row.image_type)) continue
    photos.set(row.id, { type: row.image_type, bytes: base64ToBytes(row.image_data) })
  }

  return { health, activity, summary, valuation, alerts: alertDoc, ledger, photos }
}

/** Short, stable id for the document: date + a checksum of its own inputs. */
function reportId(from, to, score, user) {
  const seed = `${from}|${to}|${score}|${user?.email ?? ''}`
  let h = 0
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const day = (from ?? '').replace(/-/g, '').slice(0, 8)
  return `SP-${day}-${h.toString(36).slice(0, 4).toUpperCase()}`
}

const daysBetween = (from, to) =>
  Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1)

/* -------------------------------------------------------------- the pages -- */

async function build(doc, fonts, data, meta) {
  const { health, activity, summary, valuation, alerts: worklist, ledger } = data
  const sheet = new Sheet(doc, fonts, meta)
  const k = health.kpis
  const range = `${dayLabel(meta.from)} - ${dayLabel(meta.to)}`
  const days = daysBetween(meta.from, meta.to)

  /* ============================================================== page 1 == */
  sheet.newPage({ dark: true })
  const { width, height } = sheet.size
  const bandBottom = height - 268

  // Hero: brand lockup, title block and the health dial.
  sheet.mark(M.x, 758, 46)
  sheet.wordmark(M.x + 56, 730, { size: 22 })
  sheet.tracked(BRAND.tagline, M.x + 57, 716, { size: 6.6, color: '#C2D6F7', spacing: 1.7 })

  sheet.tracked('INVENTORY INTELLIGENCE REPORT', M.x, 672, { size: 8, color: '#AFCBF7', spacing: 2.1 })
  sheet.text('Stock position, movement', M.x, 640, { style: 'bold', size: 25, color: palette.white })
  sheet.text('and operational health', M.x, 608, { style: 'bold', size: 25, color: palette.white })
  sheet.text(`Reporting window ${range} · ${days} days · generated ${stamp(meta.generatedAt)}`,
    M.x, 584, { size: 8.2, color: '#CBDCF8' })

  const plate = { x: width - M.x - 134, y: bandBottom + 24, width: 134, height: 158 }
  sheet.rounded({ ...plate, radius: 15, fill: palette.white, opacity: 0.97, border: null })
  sheet.dial({
    x: plate.x + 7, y: plate.y + 8, width: plate.width - 14, height: plate.height - 16,
    value: health.score.value, grade: health.score.grade, caption: health.score.label,
  })

  // Meta strip: who asked for it, over what window, from where.
  sheet.y = bandBottom - 12
  sheet.rounded({ x: M.x, y: sheet.y - 42, width: sheet.contentWidth, height: 42, radius: 11, fill: palette.white, border: palette.line })
  const metaCells = [
    ['PREPARED FOR', `${meta.user?.name ?? 'Signed-in user'} · ${String(meta.user?.role ?? 'viewer').toUpperCase()}`],
    ['DATA WINDOW', `${meta.from} to ${meta.to}`],
    ['DOCUMENT ID', meta.id],
    ['SOURCE', 'Live D1 · Cloudflare Worker'],
  ]
  metaCells.forEach(([label, value], i) => {
    const cw = sheet.contentWidth / metaCells.length
    const cx = M.x + 14 + i * cw
    sheet.tracked(label, cx, sheet.y - 16, { size: 5.8, color: palette.faint, spacing: 1 })
    sheet.text(sheet.fit(value, cw - 20, { size: 7.8 }), cx, sheet.y - 28, { style: 'bold', size: 7.8, color: palette.slate })
  })
  sheet.y -= 56

  /* --- key indicators ---------------------------------------------------- */
  sheet.sectionHead('Key indicators', `across ${nf(k.products)} active products`)
  const kpis = [
    { label: 'STOCK VALUE (COST)', value: compact(valuation.totals.cost_value), hint: `${money(valuation.totals.cost_value)} at cost` },
    { label: 'RETAIL VALUE', value: compact(valuation.totals.retail_value), hint: `margin ${compact(valuation.totals.margin_value)} (${valuation.totals.margin_pct}%)` },
    { label: 'UNITS ON HAND', value: nf(valuation.totals.units), hint: `${nf(k.products)} products` },
    { label: 'FILL RATE', value: pct(k.fill_rate, 0), hint: `${nf(k.products)} products tracked` },
    { label: 'STOCKOUT RATE', value: pct(k.stockout_rate, 0), hint: k.stockout_rate > 0 ? 'zero on hand' : 'nothing out of stock', color: k.stockout_rate > 0 ? palette.danger : palette.ink },
    { label: 'DAYS OF COVER', value: `${k.days_cover}`, hint: `at ${k.avg_daily_out} units/day` },
    { label: 'TURNOVER', value: `${k.turnover}x`, hint: 'stock turned in window' },
    { label: 'DORMANT CAPITAL', value: compact(k.dead_value), hint: `${nf(k.dead_products)} idle 30 days+`, color: k.dead_value > 0 ? palette.warn : palette.ink },
  ]
  const tileH = 46
  const tileGap = 9
  const gridTop = sheet.y
  kpis.forEach((tile, i) => {
    const colW = (sheet.contentWidth - 10 * 3) / 4
    const x = M.x + (i % 4) * (colW + 10)
    const y = gridTop - Math.floor(i / 4) * (tileH + tileGap)
    sheet.rounded({ x, y: y - tileH, width: colW, height: tileH, radius: 9, fill: palette.white, border: palette.line })
    sheet.page.drawRectangle({ x, y: y - tileH, width: 2.6, height: tileH, color: rgbOf(tile.color ?? palette.blue) })
    sheet.tracked(tile.label, x + 9, y - 12, { size: 5.6, color: palette.faint, spacing: 0.8 })
    sheet.text(tile.value, x + 9, y - 28, { style: 'bold', size: 14, color: tile.color ?? palette.ink })
    sheet.text(sheet.fit(tile.hint, colW - 16, { size: 6.4 }), x + 9, y - 38, { size: 6.4, color: palette.muted })
  })
  sheet.y = gridTop - (tileH * 2 + tileGap) - 10

  /* --- score composition + contents ------------------------------------- */
  const dims = health.dimensions
  sheet.card({
    title: 'How the score is built',
    subtitle: 'Four weighted dimensions scored 0-100, combined into the health score above.',
    content: sheet.metersHeight(dims.length, 29),
    draw: ({ x, y, width: cw }) => {
      dims.forEach((d, i) => sheet.meter({
        x, y: y - i * 29, width: cw, label: d.label, value: d.value, weight: d.weight, hint: d.fit ?? d.hint,
        color: d.value >= 80 ? palette.good : d.value >= 50 ? palette.blue : palette.warn,
      }))
    },
  })

  sheet.card({
    title: 'Inside this report',
    content: 4 * 21,
    draw: ({ x, y, width: cw }) => {
      const items = [
        ['1', 'Position & valuation', 'Stock value by category, the age of that capital and the largest holdings.'],
        ['2', 'Movement analytics', `Daily throughput across ${days} days, weekday rhythm and an hour-of-day profile.`],
        ['3', 'Attention & actions', `${nf(worklist.summary.total)} lines at or below reorder level, with costs and next steps.`],
        ['4', 'Product register', `Every active product with its position, reorder point and status - the full appendix.`],
      ]
      items.forEach(([n, title, body], i) => {
        const ry = y - i * 21
        sheet.rounded({ x, y: ry - 17, width: 17, height: 17, radius: 5, fill: palette.blue, border: null })
        sheet.text(n, x + 8.5, ry - 12.4, { style: 'bold', size: 8.4, color: palette.white, align: 'center' })
        sheet.text(title, x + 25, ry - 5, { style: 'bold', size: 8.6, color: palette.ink })
        sheet.text(sheet.fit(body, cw - 26, { size: 7.2 }), x + 25, ry - 15, { size: 7.2, color: palette.muted })
      })
    },
  })

  /* ============================================================== page 2 == */
  sheet.newPage({ title: 'Position & valuation', kicker: 'stock on hand, its shape and its age' })
  sheet.sectionHead('Capital position', `valuation of ${nf(valuation.totals.products)} active products`)
  sheet.card({
    content: 38,
    draw: ({ x, y, width: cw }) => sheet.stats([
      { label: 'STOCK VALUE (COST)', value: money(valuation.totals.cost_value) },
      { label: 'RETAIL VALUE', value: money(valuation.totals.retail_value) },
      { label: 'MARGIN AT RETAIL', value: money(valuation.totals.margin_value), color: palette.good, hint: `${valuation.totals.margin_pct}% on cost` },
      { label: 'UNITS ON HAND', value: nf(valuation.totals.units), hint: `${nf(valuation.categories.length)} categories` },
    ], { x, y, width: cw, columns: 4, rowHeight: 38, valueSize: 13 }),
  })

  const cats = valuation.categories.slice(0, 8)
  const catTones = [palette.navy, palette.blue, palette.blue2, palette.indigo, palette.cyan, palette.violet, palette.blue3, palette.faint]
  sheet.card({
    title: 'Value by category',
    subtitle: 'Cost value of stock on hand, with each category share of the total.',
    content: sheet.barsHeight(cats.length, 19),
    draw: ({ x, y, width: cw }) => sheet.hbars({
      x, y: y - 2, width: cw,
      items: cats.map((c, i) => ({ label: `${c.category} (${nf(c.products)})`, value: c.cost_value, color: catTones[i % 8] })),
      valueFormat: (v) => `${compact(v)}   ${pct((v / (valuation.totals.cost_value || 1)) * 100, 1)}`,
    }),
  })

  const aging = health.aging
  const agingTones = [palette.good, palette.blue, palette.blue2, palette.warn, palette.danger]
  sheet.card({
    title: 'Age of stock',
    subtitle: 'How long stock has sat since its last issue - the shorter the better.',
    content: 142,
    draw: ({ x, y, width: cw }) => {
      const total = aging.reduce((a, b) => a + b.value, 0) || 1
      sheet.text('Value at cost by age', x, y - 4, { style: 'bold', size: 8, color: palette.ink })
      sheet.text(`${money(total)} across ${nf(aging.reduce((a, b) => a + b.products, 0))} products`, x + cw, y - 4, { size: 7.2, color: palette.muted, align: 'right' })
      let cursor = x
      aging.forEach((a, i) => {
        const w = Math.max(6, (cw * a.value) / total)
        sheet.rounded({ x: cursor, y: y - 30, width: Math.max(3, w - 1.5), height: 15, radius: 3.5, fill: agingTones[i % 5], border: null })
        cursor += w
      })
      sheet.legend(aging.map((a, i) => ({ label: `${a.label} · ${a.share}%`, color: agingTones[i % 5] })), x, y - 44)
      sheet.table({
        x, y: y - 56, width: cw, rowHeight: 14.5, headerHeight: 15,
        columns: [
          { key: 'bucket', label: 'AGE BUCKET', width: 30, style: 'bold', color: palette.ink },
          { key: 'products', label: 'PRODUCTS', width: 14, align: 'right' },
          { key: 'value', label: 'VALUE AT COST', width: 22, align: 'right', style: 'bold', color: palette.ink },
          { key: 'share', label: 'SHARE', width: 12, align: 'right' },
          { key: 'state', label: 'STATUS', width: 15, chip: true, align: 'left' },
        ],
        rows: aging.map((a) => ({
          bucket: a.label, products: nf(a.products), value: money(a.value), share: `${a.share}%`,
          state: a.stale ? 'Review' : 'Fresh', state_tone: a.stale ? 'low' : 'ok',
        })),
      })
    },
  })

  const holdings = valuation.items.slice(0, 10)
  const holdingsValue = holdings.reduce((a, b) => a + b.stock_value, 0)
  sheet.card({
    title: 'Top holdings by value',
    subtitle: `The ${holdings.length} largest positions - ${pct((holdingsValue / (valuation.totals.cost_value || 1)) * 100, 1)} of stock value.`,
    content: sheet.tableHeight(holdings.length),
    draw: ({ x, y, width: cw }) => sheet.table({
      x, y, width: cw,
      columns: [
        { key: 'sku', label: 'SKU', width: 13, style: 'bold', color: palette.navy },
        { key: 'name', label: 'PRODUCT', width: 30 },
        { key: 'category', label: 'CATEGORY', width: 16 },
        { key: 'quantity', label: 'ON HAND', width: 12, align: 'right', format: (v, r) => `${nf(v)} ${r.unit}` },
        { key: 'cost_price', label: 'UNIT COST', width: 12, align: 'right', format: (v) => money(v) },
        { key: 'stock_value', label: 'VALUE', width: 14, align: 'right', style: 'bold', color: palette.ink, format: (v) => money(v) },
        { key: 'status', label: 'STATUS', width: 14, chip: true, format: (v) => STATUS_LABEL[v] ?? v },
      ],
      rows: holdings.map((h) => ({ ...h, status_tone: h.status === 'out' ? 'out' : h.status === 'low' ? 'low' : 'ok' })),
    }),
  })

  /* ============================================================== page 3 == */
  sheet.newPage({ title: 'Movement analytics', kicker: `${days} days of receipts and issues` })
  sheet.sectionHead('Throughput', `movements between ${meta.from} and ${meta.to}`)
  sheet.card({
    content: 38,
    draw: ({ x, y, width: cw }) => sheet.stats([
      { label: 'UNITS RECEIVED', value: nf(summary.totals.units_in), color: palette.blue },
      { label: 'UNITS ISSUED', value: nf(summary.totals.units_out), color: palette.violet },
      { label: 'NET CHANGE', value: `${summary.totals.net_units >= 0 ? '+' : ''}${nf(summary.totals.net_units)}`, color: summary.totals.net_units >= 0 ? palette.good : palette.danger },
      { label: 'MOVEMENTS LOGGED', value: nf(summary.totals.movements), hint: `${nf(summary.totals.products_moved)} products moved` },
    ], { x, y, width: cw, columns: 4, rowHeight: 38, valueSize: 13 }),
  })

  sheet.card({
    title: 'Daily throughput',
    subtitle: 'Units received and issued per day across the reporting window.',
    content: 122,
    draw: ({ x, y, width: cw }) => {
      sheet.text(`Peak day ${nf(summary.totals.busiest_day_units)} units issued · average ${summary.totals.avg_daily_out} units per day`,
        x, y - 4, { size: 7, color: palette.muted })
      sheet.legend([{ label: 'units in', color: palette.blue }, { label: 'units out', color: palette.violet }], x + 300, y - 4)
      sheet.columns({
        x, y: y - 104, width: cw, height: 78,
        series: summary.daily, labelKey: 'date',
        keys: [{ value: 'units_in', color: palette.blue }, { value: 'units_out', color: palette.violet }],
      })
    },
  })

  sheet.card({
    title: 'Weekday rhythm',
    subtitle: `Issues per day laid out week by week over ${activity.weeks.length} weeks, with the hour-of-day profile beside it.`,
    content: 126,
    draw: ({ x, y, width: cw }) => {
      sheet.text('Issues by weekday', x, y - 4, { style: 'bold', size: 7.6, color: palette.muted })
      sheet.heat({
        x: x + 24, y: y - 18, cell: 12, gap: 2.6,
        weeks: activity.weeks, weekdays: activity.weekdays, cells: activity.cells, max: activity.max.units_out,
      })
      const rightX = x + 132
      const rightW = cw - 132
      const hours = activity.hours
      const hMax = Math.max(1, ...hours.map((h) => h.units_out))
      sheet.text('Issues by hour of day', rightX, y - 4, { style: 'bold', size: 7.6, color: palette.muted })
      sheet.legend([{ label: 'quieter', color: palette.blue2 }, { label: 'busiest', color: palette.blue }], rightX + rightW, y - 4)
      const baseY = y - 108
      const slot = rightW / hours.length
      hours.forEach((h, i) => {
        const bh = (h.units_out / hMax) * 74
        if (bh > 0) sheet.rounded({
          x: rightX + i * slot + 1, y: baseY, width: Math.max(2, slot - 2), height: bh, radius: 1.4,
          fill: h.units_out > hMax * 0.66 ? palette.blue : palette.blue2, border: null,
        })
        if (i % 3 === 0) sheet.text(String(h.hour).padStart(2, '0'), rightX + i * slot + slot / 2, baseY - 9, { size: 5.6, color: palette.faint, align: 'center' })
      })
      sheet.page.drawLine({ start: { x: rightX, y: baseY }, end: { x: rightX + rightW, y: baseY }, thickness: 0.5, color: rgbOf(palette.line) })
    },
  })

  const top = summary.top_products.slice(0, 11)
  sheet.card({
    title: 'Top throughput',
    subtitle: 'Products that moved the most units out of the warehouse in the window.',
    content: sheet.tableHeight(top.length),
    draw: ({ x, y, width: cw }) => sheet.table({
      x, y, width: cw,
      columns: [
        { key: 'sku', label: 'SKU', width: 13, style: 'bold', color: palette.navy },
        { key: 'name', label: 'PRODUCT', width: 34 },
        { key: 'category', label: 'CATEGORY', width: 17 },
        { key: 'units_out', label: 'OUT', width: 10, align: 'right', style: 'bold', color: palette.violet },
        { key: 'units_in', label: 'IN', width: 10, align: 'right', color: palette.blue },
        { key: 'value_out', label: 'VALUE OUT', width: 16, align: 'right', format: (v) => money(v) },
      ],
      rows: top,
    }),
  })

  /* ============================================================== page 4 == */
  sheet.newPage({ title: 'Attention & actions', kicker: 'what to do next' })
  sheet.sectionHead('Replenishment', 'lines at or below their reorder level, ranked by coverage')

  const wl = worklist.items.slice(0, 10)
  sheet.card({
    title: 'Restock worklist',
    subtitle: worklist.summary.total
      ? `${nf(worklist.summary.total)} lines need attention - ${nf(worklist.summary.out_of_stock)} out of stock, ${nf(worklist.summary.low_stock)} running low.`
      : 'Every product is above its reorder level.',
    content: wl.length ? 42 + sheet.tableHeight(wl.length, 15.2) : 38,
    draw: ({ x, y, width: cw }) => {
      if (!wl.length) {
        sheet.callout({
          x, y: y - 14, width: cw, height: 36, tone: 'ok',
          title: 'No replenishment needed',
          body: 'No product is at or below its reorder level, so there is nothing to restock in this window.',
        })
        return
      }
      sheet.rounded({ x, y: y - 32, width: cw, height: 32, radius: 9, fill: palette.soft, border: null })
      let chipX = x + 12
      chipX += sheet.chip(`${nf(worklist.summary.out_of_stock)} OUT OF STOCK`, chipX, y - 22, { tone: 'out' }) + 7
      chipX += sheet.chip(`${nf(worklist.summary.low_stock)} LOW`, chipX, y - 22, { tone: 'low' }) + 7
      sheet.text(`Estimated cost to fully replenish: ${money(worklist.summary.restock_cost)}`,
        x + cw - 12, y - 17, { style: 'bold', size: 8.4, color: palette.ink, align: 'right' })
      sheet.table({
        x, y: y - 44, width: cw, rowHeight: 15.2,
        columns: [
          { key: 'sku', label: 'SKU', width: 14, style: 'bold', color: palette.navy, size: 7.4 },
          { key: 'name', label: 'PRODUCT', width: 22, size: 7.4 },
          { key: 'category', label: 'CATEGORY', width: 13, size: 7.4 },
          { key: 'quantity', label: 'ON HAND', width: 9.5, align: 'right', size: 7.4 },
          { key: 'reorder_level', label: 'REORDER', width: 10, align: 'right', size: 7.4 },
          { key: 'coverage', label: 'COVER', width: 9, align: 'right', color: palette.warn, size: 7.4, format: (v) => `${Math.round((v ?? 0) * 100)}%` },
          { key: 'restock_cost', label: 'RESTOCK COST', width: 13.5, align: 'right', style: 'bold', color: palette.ink, size: 7.4, format: (v) => money(v) },
          { key: 'status', label: 'STATUS', width: 13, chip: true, format: (v) => STATUS_LABEL[v] ?? v },
        ],
        rows: wl.map((i) => ({ ...i, status_tone: i.status === 'out' ? 'out' : 'low' })),
      })
    },
  })

  const actions = health.actions.length
    ? health.actions
    : [{ tone: 'ok', title: 'No corrective action needed', detail: 'Every product is above its reorder level and stock is moving.' }]
  sheet.card({
    title: 'Recommended actions',
    subtitle: 'Ordered by impact on availability and tied-up capital.',
    content: 12 + actions.length * 38,
    draw: ({ x, y, width: cw }) => {
      actions.forEach((a, i) => sheet.callout({
        x, y: y - 12 - i * 38, width: cw, height: 34,
        tone: a.tone === 'danger' ? 'out' : a.tone === 'warn' ? 'low' : a.tone === 'ok' ? 'ok' : 'info',
        title: a.title, body: a.detail,
      }))
    },
  })

  const moves = (ledger.items ?? []).slice(0, 8)
  if (moves.length) {
    const TYPE_TONE = { in: 'ok', out: 'out', adjust: 'low' }
    const TYPE_LABEL = { in: 'Stock in', out: 'Stock out', adjust: 'Adjustment' }
    sheet.card({
      title: 'Recent movement ledger',
      subtitle: `The ${moves.length} most recent entries in the window, newest first.`,
      content: sheet.tableHeight(moves.length, 14),
      draw: ({ x, y, width: cw }) => sheet.table({
        x, y, width: cw, rowHeight: 14,
        columns: [
          { key: 'created_at', label: 'WHEN', width: 16, size: 7, format: (v) => String(v ?? '').slice(5, 16) },
          { key: 'type', label: 'TYPE', width: 14, chip: true, format: (v) => TYPE_LABEL[v] ?? v },
          { key: 'sku', label: 'SKU', width: 13, style: 'bold', color: palette.navy, size: 7 },
          { key: 'product_name', label: 'PRODUCT', width: 26, size: 7 },
          { key: 'quantity', label: 'QTY', width: 9, align: 'right', size: 7, style: 'bold', color: palette.ink, format: (v) => nf(v) },
          { key: 'reference', label: 'REFERENCE', width: 22, size: 7 },
        ],
        rows: moves.map((m) => ({ ...m, type_tone: TYPE_TONE[m.type] ?? 'neutral' })),
      }),
    })
  }

  /* ============================================================== page 5 == */
  const gallery = valuation.items.slice(0, 30)
  const galleryPhotos = new Map()
  await Promise.all(gallery.map(async (item) => {
    const stored = data.photos?.get(item.id)
    if (!stored) return
    try {
      const image = stored.type === 'image/png' ? await doc.embedPng(stored.bytes) : await doc.embedJpg(stored.bytes)
      galleryPhotos.set(item.id, image)
    } catch {
      /* an unreadable blob falls back to the generated artwork */
    }
  }))
  const GCOLS = 3
  const GROW = 62
  sheet.newPage({ title: 'Appendix · product gallery', kicker: 'every active product and its artwork' })
  const withPhoto = gallery.filter((item) => galleryPhotos.has(item.id)).length
  sheet.sectionHead(
    'Product gallery',
    `${nf(gallery.length)} of ${nf(valuation.totals.products)} products, largest holding first${withPhoto ? ` · ${nf(withPhoto)} shown as a stored photo` : ''}`,
  )
  sheet.card({
    title: '',
    content: Math.ceil(gallery.length / GCOLS) * GROW + 6,
    draw: ({ x, y, width: cw }) => {
      const gap = 8
      const cellW = (cw - gap * (GCOLS - 1)) / GCOLS
      gallery.forEach((item, i) => {
        const col = i % GCOLS
        const row = Math.floor(i / GCOLS)
        const cx = x + col * (cellW + gap)
        const cy = y - row * GROW
        const photo = galleryPhotos.get(item.id)
        const art = photo
          ? sheet.photoTile({ x: cx, y: cy - 50, size: 48, image: photo, product: item })
          : sheet.artTile({ x: cx, y: cy - 50, size: 48, product: item })
        const textX = cx + 56
        const textW = cellW - 60
        sheet.text(sheet.fit(item.name, textW, { style: 'bold', size: 7.4 }), textX, cy - 12, { style: 'bold', size: 7.4, color: palette.ink })
        sheet.text(sheet.fit(`${item.sku} · ${item.category}`, textW, { size: 6.4 }), textX, cy - 21, { size: 6.4, color: palette.muted })
        sheet.text(sheet.fit(`${nf(item.quantity)} ${item.unit} · ${money(item.stock_value)} at cost`, textW, { size: 6.4 }), textX, cy - 30, { size: 6.4, color: palette.slate })
        sheet.chip(STATUS_LABEL[item.status] ?? item.status, textX, cy - 48, {
          tone: item.status === 'out' ? 'out' : item.status === 'low' ? 'low' : 'ok',
        })
      })
      return Math.ceil(gallery.length / GCOLS) * GROW
    },
  })

  /* ============================================================== page 5 == */
  const register = valuation.items.slice(0, 44)
  sheet.newPage({ title: 'Appendix · product register', kicker: `all ${nf(valuation.totals.products)} active products, by value` })
  sheet.sectionHead('Product register', `${nf(register.length)} of ${nf(valuation.totals.products)} products shown, largest holding first`)
  sheet.card({
    title: '',
    content: sheet.tableHeight(register.length, 14),
    draw: ({ x, y, width: cw }) => sheet.table({
      x, y, width: cw, rowHeight: 14, headerHeight: 15,
      columns: [
        { key: 'sku', label: 'SKU', width: 13, style: 'bold', color: palette.navy, size: 7 },
        { key: 'name', label: 'PRODUCT', width: 27, size: 7 },
        { key: 'category', label: 'CATEGORY', width: 14, size: 7 },
        { key: 'quantity', label: 'ON HAND', width: 10, align: 'right', size: 7, format: (v, r) => `${nf(v)} ${r.unit}` },
        { key: 'reorder_level', label: 'REORDER', width: 9, align: 'right', size: 7 },
        { key: 'cost_price', label: 'COST', width: 10, align: 'right', size: 7, format: (v) => money(v) },
        { key: 'sale_price', label: 'SALE', width: 10, align: 'right', size: 7, format: (v) => money(v) },
        { key: 'stock_value', label: 'VALUE', width: 12, align: 'right', style: 'bold', color: palette.ink, size: 7, format: (v) => money(v) },
        { key: 'status', label: 'STATUS', width: 13, chip: true, format: (v) => STATUS_LABEL[v] ?? v },
      ],
      rows: register.map((r) => ({ ...r, status_tone: r.status === 'out' ? 'out' : r.status === 'low' ? 'low' : 'ok' })),
    }),
  })

  sheet.card({
    title: 'Method & definitions',
    content: 96,
    draw: ({ x, y, width: cw }) => {
      const notes = [
        'Health score: availability 35%, movement 30%, freshness 20% and balance 15%. Each dimension is scored 0-100 against its own thresholds, then weighted into the composite score and graded A to D.',
        'Days of cover: units on hand divided by average daily issues. Turnover: units issued divided by units on hand over the window. Dormant capital: value of stock with no issue in 30 days.',
        'Low stock means quantity is at or below the product reorder level; out of stock means zero on hand. Restock cost is the shortfall up to the reorder level valued at unit cost.',
        `Source: the live D1 database behind the Cloudflare Worker. Figures are point-in-time at ${stamp(meta.generatedAt)} and can differ from a later view.`,
      ]
      let cy = y - 2
      notes.forEach((note) => {
        const lines = sheet.wrap(note, cw, { size: 6.8 })
        lines.forEach((line, i) => sheet.text(line, x, cy - i * 9.4, { size: 6.8, color: palette.muted }))
        cy -= lines.length * 9.4 + 3
      })
    },
  })

  sheet.finishFooters()
}

/* ------------------------------------------------------------- entry point -- */

const today = () => new Date().toISOString().slice(0, 10)
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

/**
 * GET /api/report.pdf?from=&to=&inline=1
 * Renders the decorated inventory report and returns it as a download.
 */
export async function reportPdf(env, url, user) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') ?? '') ? url.searchParams.get('to') : today()
  const rawFrom = url.searchParams.get('from')
  const from = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom ?? '') ? rawFrom : shift(to, -29)
  if (Date.parse(from) > Date.parse(to)) throw badRequest('from must be before to')

  const doc = await PDFDocument.create()
  doc.setTitle(`${BRAND.name} inventory intelligence report ${from} to ${to}`)
  doc.setAuthor(`${BRAND.name} · ${BRAND.product}`)
  doc.setSubject('Stock position, movement analytics and replenishment actions')
  doc.setProducer(BRAND.product)
  doc.setCreator(BRAND.name)
  doc.setCreationDate(new Date())
  doc.setKeywords([BRAND.name, 'inventory', 'report', 'stock', from, to])

  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }

  const data = await collect(env, from, to)
  const meta = {
    from, to,
    generatedAt: new Date().toISOString(),
    id: reportId(from, to, data.health.score.value, user),
    user,
    docTitle: `${BRAND.name.toUpperCase()} · INVENTORY REPORT`,
  }

  await build(doc, fonts, data, meta)

  const bytes = await doc.save({ useObjectStreams: false })
  const filename = `stockpilot-report-${from}_${to}.pdf`
  const inline = url.searchParams.get('inline') === '1'

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-report-id': meta.id,
      'x-report-pages': String(doc.getPageCount()),
    },
  })
}
