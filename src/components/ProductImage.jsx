/* ==========================================================================
   Product artwork components.

   <ProductArt>   the generated tile (gradient + category glyph + monogram)
   <ProductImage> prefers a real photo when the product carries one, and falls
                  back to the generated tile if it is missing or fails to load.
   ========================================================================== */
import { useState } from 'react'
import { artFor, hasPhoto, productImageUrl } from '../product-art.js'

let uid = 0
const nextId = () => `pa-${(uid += 1)}`

/** Diagonal hatch drawn over the gradient, in tile coordinates. */
const HATCH = Array.from({ length: 6 }, (_, i) => `M${-12 + i * 8} 24 L${4 + i * 8} 0`).join(' ')

export function ProductArt({ product, size = 34, radius = null, monogram: showMonogram = true, className = '', style }) {
  const [id] = useState(nextId)
  const art = artFor(product)
  const r = radius ?? Math.max(6, size * 0.26)
  const badge = showMonogram && size >= 44

  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" role="presentation" aria-hidden="true"
      className={`product-art ${className}`.trim()} style={style}
      data-art={art.family} data-tone={art.tone.from} data-monogram={art.monogram}
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={art.tone.from} />
          <stop offset="100%" stopColor={art.tone.to} />
        </linearGradient>
        <clipPath id={`${id}-c`}>
          <rect x="0" y="0" width="24" height="24" rx={(r / size) * 24} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-c)`}>
        <rect x="0" y="0" width="24" height="24" fill={`url(#${id}-g)`} />
        <path d={HATCH} stroke="#FFFFFF" strokeWidth="1.6" opacity="0.09" />
        <circle cx="6.5" cy="5.5" r="10" fill="#FFFFFF" opacity="0.10" />
        <circle cx="22" cy="22" r="9" fill="#000000" opacity="0.10" />
        {/* the glyph is centred on its own; larger tiles scale it down slightly
            to leave room for the monogram badge in the corner */}
        <g transform={badge ? 'translate(12 11) scale(0.74) translate(-12 -12)' : undefined}>
          <path
            d={art.glyph} fill="none" stroke="#FFFFFF" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round" opacity="0.95"
          />
        </g>
        {badge && (
          <text
            x="21.6" y="22.4" textAnchor="end" fontSize="5.6" fontWeight="700"
            fill="#FFFFFF" opacity="0.5" letterSpacing="0.1"
          >
            {art.monogram}
          </text>
        )}
      </g>
    </svg>
  )
}

/**
 * The product picture used in tables, cards and detail panels. A stored photo
 * wins; the generated tile is both the fallback and the default.
 */
export function ProductImage({
  product, size = 34, radius = null, monogram = true, className = '',
  alt = null, title = null, style,
}) {
  const [broken, setBroken] = useState(false)
  const url = productImageUrl(product)

  if (!hasPhoto(product) || broken) {
    return <ProductArt product={product} size={size} radius={radius} monogram={monogram} className={className} style={style} />
  }

  const r = radius ?? Math.max(6, size * 0.26)
  return (
    <img
      src={url} alt={alt ?? product?.name ?? 'Product'} title={title ?? product?.name}
      loading="lazy" decoding="async" width={size} height={size}
      className={`product-photo ${className}`.trim()}
      style={{ width: size, height: size, borderRadius: r, ...style }}
      onError={() => setBroken(true)}
      data-src={url}
    />
  )
}

export default ProductImage
