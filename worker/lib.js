// Shared helpers: responses, errors, validation and query building.

export class HttpError extends Error {
  constructor(status, message, details, headers = {}) {
    super(message)
    this.status = status
    this.details = details
    this.headers = headers
  }
}

export const fail = (status, message, details) => new HttpError(status, message, details)
export const badRequest = (message, details) => new HttpError(400, message, details)
export const notFound = (message = 'Resource not found') => new HttpError(404, message)

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

export async function readJson(request) {
  const text = await request.text()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed
  } catch (err) {
    throw badRequest(`Invalid JSON body: ${err.message}`)
  }
}

export function toInt(value, field, { min = null, max = null, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback
    throw badRequest(`\`${field}\` is required`)
  }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest(`\`${field}\` must be an integer`)
  }
  if (min !== null && n < min) throw badRequest(`\`${field}\` must be >= ${min}`)
  if (max !== null && n > max) throw badRequest(`\`${field}\` must be <= ${max}`)
  return n
}

export function toNumber(value, field, { min = null, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw badRequest(`\`${field}\` must be a number`)
  if (min !== null && n < min) throw badRequest(`\`${field}\` must be >= ${min}`)
  return Math.round(n * 100) / 100
}

export function requireString(value, field, { max = 200, fallback = null, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback
    throw badRequest(`\`${field}\` is required`)
  }
  const s = String(value).trim()
  if (!s && !allowEmpty) throw badRequest(`\`${field}\` cannot be empty`)
  if (s.length > max) throw badRequest(`\`${field}\` must be at most ${max} characters`)
  return s
}

/** Only allow known sort columns through to SQL. */
export function orderBy(raw, allowed, defaultColumn) {
  const spec = String(raw || '')
  if (!spec) return `ORDER BY ${defaultColumn}`
  const [column, dirRaw] = spec.split(':')
  const dir = String(dirRaw || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
  const entry = allowed[column]
  for (const [key, expr] of Object.entries(allowed)) {
    if (key === column && entry) return `ORDER BY ${expr} ${dir}`
  }
  return `ORDER BY ${defaultColumn}`
}

export function pagination(url, { defaultLimit = 20, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || defaultLimit, 1), maxLimit)
  const page = Math.max(Number(url.searchParams.get('page')) || 1, 1)
  return { limit, page, offset: (page - 1) * limit }
}

/**
 * Optional photo URL. Only http(s) is accepted (never javascript:/data:), the
 * value is length-capped and an empty string clears it.
 */
export function cleanImageUrl(value, field = 'image_url') {
  if (value === undefined || value === null) return undefined
  const raw = String(value).trim()
  if (raw === '') return ''
  if (raw.length > 500) throw badRequest('`image_url` must be 500 characters or fewer')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw badRequest('`image_url` must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('`image_url` must use http or https')
  }
  return parsed.toString()
}

/**
 * An uploaded product photo, as a data URL (`data:image/jpeg;base64,...`) or a
 * bare base64 string plus its mime type. Only raster formats a PDF can embed
 * and a browser can render are accepted, and the decoded bytes are capped so a
 * row can never be ballooned by a client.
 */
export const STORED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const STORED_IMAGE_MAX_BYTES = 256 * 1024

export function cleanStoredImage(value, type) {
  if (value === undefined || value === null) return undefined
  let raw = String(value).trim()
  let mime = String(type ?? '').trim().toLowerCase()
  if (raw === '') return { data: '', type: '' }

  const match = /^data:([^;,]+);base64,(.*)$/s.exec(raw)
  if (match) {
    mime = match[1].trim().toLowerCase()
    raw = match[2].replace(/\s+/g, '')
  }
  if (!STORED_IMAGE_TYPES.includes(mime)) {
    throw badRequest(`\`image_type\` must be one of ${STORED_IMAGE_TYPES.join(', ')}`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw badRequest('`image_data` must be base64-encoded bytes')
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0
  const bytes = (raw.length / 4) * 3 - padding
  if (bytes <= 0) throw badRequest('`image_data` must not be empty')
  if (bytes > STORED_IMAGE_MAX_BYTES) {
    throw badRequest(`\`image_data\` must decode to ${STORED_IMAGE_MAX_BYTES} bytes or fewer`)
  }
  return { data: raw, type: mime }
}

/**
 * The URL a client can load a product's picture from. An uploaded photo is
 * served by its own endpoint (bytes never travel in list payloads) and the
 * version stamp makes the browser refetch when the photo is replaced; a linked
 * photo url passes straight through.
 */
export function productImageUrl(row, origin = '') {
  if (!row) return ''
  if (row.has_photo) {
    const path = `/api/products/${row.id}/image?v=${String(row.updated_at ?? '').replace(/\D/g, '')}`
    return origin ? `${origin}${path}` : path
  }
  return row.image_url ?? ''
}

/** Decode a base64 payload to bytes for an image response. */
export function base64ToBytes(payload) {
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function cleanDate(value, field) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(`\`${field}\` must be YYYY-MM-DD`)
  return s
}

/** Format a number as a fixed 2dp string for CSV output. */
export const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2)

/** Escape one CSV field (RFC 4180). */
export function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const csv = (rows) => rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
