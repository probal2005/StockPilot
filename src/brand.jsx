/* ==========================================================================
   StockPilot brand components.

   All geometry lives in ./brand-art.js, so the inline React <svg> below, the
   files written to public/ by scripts/build-logo.mjs and the cyber watermark
   are guaranteed to be the same artwork.
   ========================================================================== */

import { useId } from 'react'
import { BRAND, HUD, MARK, markLayers, wireframeLayers } from './brand-art.js'

/** Paint the layer list produced by brand-art (fills, hairlines, ink swaps). */
function Layers({ layers, ink }) {
  return layers.map((layer, i) => (
    <path
      key={`${i}-${layer.d.slice(0, 12)}`}
      d={layer.d}
      fill={layer.stroke ? 'none' : (ink ?? BRAND.colors[layer.tone])}
      stroke={layer.stroke ? (ink ?? BRAND.colors[layer.tone]) : undefined}
      strokeWidth={layer.stroke}
      strokeLinecap={layer.stroke ? 'round' : undefined}
      strokeLinejoin={layer.stroke ? 'round' : undefined}
    />
  ))
}

/**
 * The StockPilot mark: crate, barcode label, rising bars, paper plane and
 * orbital swoosh, printed on its light plate so it stays legible on any
 * background. Pass `title` to expose it to assistive tech.
 */
export function LogoMark({ size = 40, title, className = '', chip = true, style }) {
  const label = title || undefined
  return (
    <svg
      viewBox={MARK.viewBox} width={size} height={size} style={style} focusable="false"
      className={`logo-mark ${className}`.trim()}
      role={label ? 'img' : 'presentation'}
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      data-brand="stockpilot"
    >
      {chip && (
        <rect
          className="logo-chip" x={MARK.chip.x} y={MARK.chip.y} width={MARK.chip.width}
          height={MARK.chip.height} rx={MARK.chip.rx} fill={BRAND.colors.chip}
        />
      )}
      <Layers layers={markLayers()} />
    </svg>
  )
}

/** Outline version of the mark — used for ghost marks and the watermark. */
export function LogoWireframe({ size = 128, className = '', style }) {
  return (
    <svg
      viewBox={MARK.viewBox} width={size} height={size} style={style} focusable="false"
      className={`logo-wireframe ${className}`.trim()} aria-hidden="true" data-brand="stockpilot-wire"
    >
      <Layers layers={wireframeLayers().map((l) => ({ ...l, stroke: l.stroke, tone: undefined }))} ink="currentColor" />
    </svg>
  )
}

/** Mark + two-tone wordmark + tagline (sidebar, headers, print). */
export function Logo({ size = 40, tagline = BRAND.tagline, className = '', title = BRAND.name }) {
  return (
    <span className={`logo ${className}`.trim()} data-testid="brand-logo">
      <LogoMark size={size} title={title} className="logo-badge" />
      <span className="logo-copy">
        <span className="logo-word" aria-hidden="true">
          <strong className="logo-word-a">{BRAND.nameParts[0]}</strong>
          <strong className="logo-word-b">{BRAND.nameParts[1]}</strong>
        </span>
        {tagline ? <small className="logo-tagline">{tagline}</small> : null}
      </span>
    </span>
  )
}

/**
 * The site watermark: ONE cyber emblem in the middle of the viewport.
 *
 * A faint technical grid, a slow scanline, a rotating HUD ring and the outline
 * mark, all in the brand blue at low strength. Purely decorative: it never
 * receives pointer events and is hidden from assistive tech and from print.
 */
export function CyberWatermark() {
  return (
    <div
      className="site-watermark" data-testid="site-watermark" aria-hidden="true"
      data-brand="stockpilot-watermark"
      style={{ '--cyber-size': BRAND.watermark.size }}
    >
      <span className="cyber-grid" />
      <span className="cyber-glow" />
      <div className="cyber-emblem">
        <span className="cyber-ring" />
        {['tl', 'tr', 'br', 'bl'].map((corner) => <span key={corner} className={`cyber-bracket cyber-bracket-${corner}`} />)}
        <LogoWireframe className="cyber-mark" size="100%" />
        <span className="cyber-label">{HUD.label}</span>
      </div>
      <span className="cyber-scan" />
    </div>
  )
}

/** Oversized ghost mark used as a background flourish (sidebar, empty states). */
export function GhostMark({ size = 260, className = '', style }) {
  return <LogoWireframe size={size} className={`ghost-mark ${className}`.trim()} style={style} />
}

/** Compact brand credit for the sidebar footer. */
export function BrandCredit({ className = '' }) {
  return (
    <span className={`brand-credit ${className}`.trim()} data-testid="brand-credit">
      <LogoMark size={18} className="credit-mark" />
      <span>
        {BRAND.name} · {BRAND.tagline}
      </span>
    </span>
  )
}

/** Page footer: lockup, product line and a link to the downloadable brand files. */
export function BrandFooter({ className = '' }) {
  const year = new Date().getFullYear()
  return (
    <footer className={`app-foot ${className}`.trim()} data-testid="brand-footer">
      <span className="app-foot-brand">
        <LogoMark size={24} title={BRAND.name} />
        <span>
          <strong className="logo-word-a">{BRAND.nameParts[0]}</strong>
          <strong className="logo-word-b">{BRAND.nameParts[1]}</strong>
          {' · '}
          {BRAND.product}
        </span>
      </span>
      <span className="muted">
        © {year} {BRAND.name} — {BRAND.tagline.toLowerCase()}
        {' · '}
        <a className="app-foot-link" href="/logo.svg" download={`${BRAND.name}-logo.svg`}>Brand assets</a>
      </span>
    </footer>
  )
}
