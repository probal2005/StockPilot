/* ==========================================================================
   Product artwork — one source of truth for how a product "looks".

   Every product gets a deterministic tile: a two-tone gradient in its category
   family, a category glyph and a monogram. The same module is imported by the
   React components (src/components/ProductImage.jsx), by the PDF composer
   (worker/report-pdf.js) and by anything that needs to describe the art, so a
   product cannot look different in two places.

   Glyph paths are authored in a 24x24 box using only M / L / C / Z commands and
   are drawn as strokes: pdf-lib's SVG path engine and the browser both handle
   that identically, with no arc or transform support needed.
   ========================================================================== */

export const GLYPH_BOX = 24
export const GLYPH_STROKE = 1.7

/** Category families. `tones` rotate deterministically per SKU for variety. */
export const CATEGORY_ART = {
  Electronics: {
    label: 'Electronics',
    tones: [['#1E4FB8', '#4C8DF6'], ['#123A7A', '#2E6FE3'], ['#1D3E8F', '#38BDF8']],
    glyph: 'M4.5 4.5 L19.5 4.5 L19.5 15.5 L4.5 15.5 Z M12 15.5 L12 19.6 M8 19.6 L16 19.6',
  },
  Networking: {
    label: 'Networking',
    tones: [['#4338CA', '#7C3AED'], ['#312E81', '#6366F1'], ['#3730A3', '#818CF8']],
    glyph: 'M4 9.6 C6.3 7.4 9 6.3 12 6.3 C15 6.3 17.7 7.4 20 9.6 M6.6 12.7 C8.1 11.2 10 10.4 12 10.4 C14 10.4 15.9 11.2 17.4 12.7 M11.2 15.4 L12.8 15.4 L12.8 17 L11.2 17 Z',
  },
  Storage: {
    label: 'Storage',
    tones: [['#0E7490', '#22D3EE'], ['#0F766E', '#2DD4BF'], ['#155E75', '#38BDF8']],
    glyph: 'M4.5 5.5 L19.5 5.5 L19.5 11 L4.5 11 Z M4.5 13 L19.5 13 L19.5 18.5 L4.5 18.5 Z M16.2 8.2 L17.9 8.2 M16.2 15.7 L17.9 15.7',
  },
  'Office Supplies': {
    label: 'Office supplies',
    tones: [['#5B21B6', '#8B5CF6'], ['#4C1D95', '#7C3AED'], ['#6D28D9', '#A78BFA']],
    glyph: 'M6.6 4.5 L14.6 4.5 L18 7.9 L18 19.5 L6.6 19.5 Z M14.6 4.5 L14.6 7.9 L18 7.9 M9.6 12.2 L15 12.2 M9.6 15.4 L13.4 15.4',
  },
  Accessories: {
    label: 'Accessories',
    tones: [['#B45309', '#F59E0B'], ['#92400E', '#FBBF24'], ['#A16207', '#FCD34D']],
    glyph: 'M6.2 13.4 L6.2 11.6 C6.2 8.4 8.8 5.8 12 5.8 C15.2 5.8 17.8 8.4 17.8 11.6 L17.8 13.4 M4.6 12.8 L7.4 12.8 L7.4 18.4 L4.6 18.4 Z M16.6 12.8 L19.4 12.8 L19.4 18.4 L16.6 18.4 Z',
  },
  Furniture: {
    label: 'Furniture',
    tones: [['#0F766E', '#14B8A6'], ['#115E59', '#2DD4BF']],
    glyph: 'M4.5 8 L12 4.5 L19.5 8 L19.5 16.5 L12 20 L4.5 16.5 Z M4.5 8 L12 11.5 L19.5 8 M12 11.5 L12 20',
  },
  __default: {
    label: 'General stock',
    tones: [['#0A2A63', '#16407C'], ['#1E3A8A', '#2563EB'], ['#27364F', '#475569']],
    glyph: 'M4.5 8 L12 4.5 L19.5 8 L19.5 16.5 L12 20 L4.5 16.5 Z M4.5 8 L12 11.5 L19.5 8 M12 11.5 L12 20',
  },
}

/** Stable 32-bit hash so a SKU always picks the same tone. */
export function artSeed(value) {
  let h = 2166136261
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0)
}

/** Up to two initials from a product name ("Wireless Mouse Pro" -> "WM"). */
export function monogram(name) {
  const words = String(name ?? '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/**
 * The artwork description for a product: category family, gradient stops, glyph
 * path, monogram and the seed that picked them.
 */
export function artFor(product = {}) {
  const family = CATEGORY_ART[product.category] ?? CATEGORY_ART.__default
  const seed = artSeed(product.sku || product.name || 'product')
  const [from, to] = family.tones[seed % family.tones.length]
  return {
    family: product.category && CATEGORY_ART[product.category] ? product.category : '__default',
    label: family.label,
    glyph: family.glyph,
    tone: { from, to },
    monogram: monogram(product.name),
    seed,
  }
}

/** A real photo attached to the product, if one is set. */
export const productImageUrl = (product) => String(product?.image_url ?? '').trim()

export const hasPhoto = (product) => productImageUrl(product) !== ''
