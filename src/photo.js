/* ==========================================================================
   Client-side photo intake for the product form.

   A picked file is downscaled on a canvas to a compact JPEG (long edge 512px)
   before it is sent, so an upload stays well inside the worker's byte cap and a
   catalogue list never carries megabytes. Where a canvas is unavailable the
   original bytes are passed through untouched, and the worker still enforces
   the format and size limits.
   ========================================================================== */

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const PHOTO_MAX_INPUT = 12 * 1024 * 1024

const MAX_EDGE = 512
const QUALITY = 0.82

/** File -> { data, type, name, width, height, bytes } ; throws on a bad file. */
export function readPhotoFile(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  if (!file) throw new Error('Choose an image file first')
  const type = String(file.type || '').toLowerCase()
  if (!PHOTO_TYPES.includes(type)) throw new Error('Use a PNG, JPEG or WebP image')
  if (file.size > PHOTO_MAX_INPUT) throw new Error('That image is larger than 12 MB')
  return downscale(file, { maxEdge, quality })
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That file is not a readable image'))
    img.src = dataUrl
  })
}

async function downscale(file, { maxEdge, quality }) {
  const original = await readAsDataUrl(file)
  const canvas = document.createElement('canvas')
  let ctx = null
  try {
    ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  } catch {
    ctx = null // a canvas that cannot give a 2D context is no canvas at all
  }
  // No canvas engine (older browsers, tests): send the untouched bytes.
  if (!ctx) return finish(original, typeOf(original) || file.type, file, null)

  const img = await loadImage(original)
  const scale = Math.min(1, maxEdge / Math.max(img.width || maxEdge, img.height || maxEdge))
  const width = Math.max(1, Math.round((img.width || maxEdge) * scale))
  const height = Math.max(1, Math.round((img.height || maxEdge) * scale))
  canvas.width = width
  canvas.height = height
  ctx.drawImage(img, 0, 0, width, height)

  let out
  try {
    out = canvas.toDataURL('image/jpeg', quality)
  } catch {
    out = original // e.g. a tainted canvas — the original is still valid
  }
  if (!out.startsWith('data:image/')) out = original
  return finish(out, typeOf(out) || file.type, file, { width, height })
}

const typeOf = (dataUrl) => (/^data:([^;,]+)[;,]/.exec(dataUrl)?.[1] ?? '').toLowerCase()

function finish(dataUrl, type, file, size) {
  return {
    data: dataUrl,
    type,
    name: file.name || 'photo',
    width: size?.width ?? null,
    height: size?.height ?? null,
    bytes: Math.max(0, Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4)),
  }
}

export default readPhotoFile
