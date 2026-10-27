// Stock movements: goods-in, goods-out and stocktake adjustments.
import {
  badRequest,
  cleanDate,
  fail,
  json,
  notFound,
  pagination,
  readJson,
  requireString,
  toInt,
  toNumber,
} from './lib.js'

const MOVEMENT_COLUMNS = `m.id, m.product_id, m.type, m.quantity, m.unit_cost, m.reference, m.note,
  m.balance_after, m.created_at, p.sku, p.name AS product_name, p.category, p.unit`

const MOVEMENT_SORT = {
  date: 'm.created_at',
  quantity: 'm.quantity',
  product: 'p.name',
  type: 'm.type',
}

export async function listMovements(env, url) {
  const where = []
  const params = []
  const search = String(url.searchParams.get('search') || '').trim()
  const type = String(url.searchParams.get('type') || '').trim().toLowerCase()
  const productId = url.searchParams.get('product_id')
  const from = cleanDate(url.searchParams.get('from'), 'from')
  const to = cleanDate(url.searchParams.get('to'), 'to')

  if (type) {
    if (!['in', 'out', 'adjust'].includes(type)) throw badRequest('`type` must be in, out or adjust')
    where.push('m.type = ?')
    params.push(type)
  }
  if (productId) {
    where.push('m.product_id = ?')
    params.push(toInt(productId, 'product_id', { min: 1 }))
  }
  if (from) { where.push('date(m.created_at) >= ?'); params.push(from) }
  if (to) { where.push('date(m.created_at) <= ?'); params.push(to) }
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR m.reference LIKE ? ESCAPE '\\' OR m.note LIKE ? ESCAPE '\\')`)
    params.push(term, term, term, term)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { limit, page, offset } = pagination(url, { defaultLimit: 25 })
  const dir = String(url.searchParams.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const sortKey = String(url.searchParams.get('sort') || 'date').split(':')[0]
  const order = MOVEMENT_SORT[sortKey] || MOVEMENT_SORT.date

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN m.type = 'in' THEN m.quantity ELSE 0 END), 0) AS units_in,
            COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity ELSE 0 END), 0) AS units_out
     FROM stock_movements m JOIN products p ON p.id = m.product_id ${clause}`,
  ).bind(...params).first()

  const { results } = await env.DB.prepare(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movements m JOIN products p ON p.id = m.product_id
     ${clause} ORDER BY ${order} ${dir}, m.id ${dir} LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all()

  const total = totals?.total ?? 0
  return json({
    items: results ?? [],
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    totals: { units_in: totals?.units_in ?? 0, units_out: totals?.units_out ?? 0 },
  })
}

/**
 * Records one movement and moves the product balance in the same batch.
 * `type: 'out'` refuses to drive stock negative; use an `adjust` for stocktakes.
 */
export async function createMovement(env, request) {
  const body = await readJson(request)
  const productId = toInt(body.product_id, 'product_id', { min: 1 })
  const type = String(body.type || '').trim().toLowerCase()
  if (!['in', 'out', 'adjust'].includes(type)) {
    throw badRequest('`type` must be in, out or adjust')
  }
  const quantity = toInt(body.quantity, 'quantity', { min: 1, max: 100000000 })
  const unitCost = toNumber(body.unit_cost, 'unit_cost', { min: 0, fallback: null })
  const reference = requireString(body.reference, 'reference', { max: 80, allowEmpty: true, fallback: '' })
  const note = requireString(body.note, 'note', { max: 500, allowEmpty: true, fallback: '' })

  const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first()
  if (!product) throw notFound(`Product ${productId} not found`)
  if (!product.is_active) throw fail(409, `${product.sku} is archived; restore it before moving stock`)

  let delta
  let balanceAfter
  if (type === 'in') {
    delta = quantity
    balanceAfter = product.quantity + quantity
  } else if (type === 'out') {
    if (quantity > product.quantity) {
      throw fail(409, `Insufficient stock for ${product.sku}: ${product.quantity} ${product.unit} on hand, ${quantity} requested`, {
        available: product.quantity,
        requested: quantity,
      })
    }
    delta = -quantity
    balanceAfter = product.quantity - quantity
  } else {
    // Adjustment records the delta and sets the balance to the counted figure.
    delta = quantity - product.quantity
    balanceAfter = quantity
    if (delta === 0) throw badRequest('Adjustment quantity matches current stock; nothing to record')
  }

  const movementType = type === 'adjust' ? (delta > 0 ? 'in' : 'out') : type
  const cost = unitCost === null ? (type === 'out' ? product.sale_price : product.cost_price) : unitCost

  const [, updated] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(productId, movementType, Math.abs(delta), cost, reference, note || (type === 'adjust' ? 'Stocktake adjustment' : ''), balanceAfter),
    env.DB.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?").bind(balanceAfter, productId),
  ])

  const movementId = updated?.meta?.last_row_id ?? null
  const movement = await env.DB.prepare(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE m.id = (SELECT MAX(id) FROM stock_movements WHERE product_id = ?)`,
  ).bind(productId).first()

  const refreshed = await env.DB.prepare(
    `SELECT id, sku, name, quantity, reorder_level, unit,
            CASE WHEN quantity <= 0 THEN 'out' WHEN quantity <= reorder_level THEN 'low' ELSE 'ok' END AS status
     FROM products WHERE id = ?`,
  ).bind(productId).first()

  return json({ movement, movement_id: movementId, product: refreshed, delta }, 201)
}

/** Bulk goods receipt / dispatch in one call (used by the stock screen). */
export async function createBulkMovements(env, request) {
  const body = await readJson(request)
  const type = String(body.type || '').trim().toLowerCase()
  if (!['in', 'out'].includes(type)) throw badRequest('Bulk movements support `in` and `out` only')
  const lines = Array.isArray(body.lines) ? body.lines : null
  if (!lines || !lines.length) throw badRequest('`lines` must be a non-empty array')
  if (lines.length > 100) throw badRequest('A bulk movement is limited to 100 lines')

  const reference = requireString(body.reference, 'reference', { max: 80, allowEmpty: true, fallback: '' })
  const note = requireString(body.note, 'note', { max: 500, allowEmpty: true, fallback: '' })
  const ids = lines.map((l) => toInt(l.product_id, 'product_id', { min: 1 }))
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).bind(...ids).all()
  const byId = new Map((results ?? []).map((p) => [p.id, p]))

  const applied = []
  const rejected = []
  const statements = []
  const balances = new Map()

  lines.forEach((line, index) => {
    const id = ids[index]
    const product = byId.get(id)
    const quantity = Math.trunc(Number(line.quantity) || 0)
    const current = balances.has(id) ? balances.get(id) : product?.quantity ?? 0
    if (!product) return rejected.push({ product_id: id, reason: 'Product not found' })
    if (quantity <= 0) return rejected.push({ product_id: id, sku: product.sku, reason: 'Quantity must be positive' })
    if (!product.is_active) return rejected.push({ product_id: id, sku: product.sku, reason: 'Product is archived' })
    if (type === 'out' && quantity > current) {
      return rejected.push({ product_id: id, sku: product.sku, reason: `Only ${current} ${product.unit} available` })
    }
    const balanceAfter = type === 'in' ? current + quantity : current - quantity
    balances.set(id, balanceAfter)
    const cost = type === 'out' ? product.sale_price : product.cost_price
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(id, type, quantity, cost, reference, note, balanceAfter),
      env.DB.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?").bind(balanceAfter, id),
    )
    applied.push({ product_id: id, sku: product.sku, name: product.name, quantity, balance_after: balanceAfter })
  })

  if (statements.length) await env.DB.batch(statements)
  return json({ applied, rejected, applied_count: applied.length, rejected_count: rejected.length }, applied.length ? 201 : 409)
}

export async function deleteMovement(env, id) {
  const movement = await env.DB.prepare('SELECT * FROM stock_movements WHERE id = ?').bind(id).first()
  if (!movement) throw notFound(`Movement ${id} not found`)
  const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(movement.product_id).first()
  if (!product) throw notFound('Product for this movement no longer exists')

  const delta = movement.type === 'in' ? -movement.quantity : movement.quantity
  const balanceAfter = product.quantity + delta
  if (balanceAfter < 0) {
    throw fail(409, 'Reversing this movement would drive stock negative; adjust the product instead')
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, datetime('now'))`,
    ).bind(
      movement.product_id,
      delta > 0 ? 'in' : 'out',
      Math.abs(delta),
      'REVERSAL',
      `Reversal of movement #${movement.id}`,
      balanceAfter,
    ),
    env.DB.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?").bind(balanceAfter, movement.product_id),
    env.DB.prepare('DELETE FROM stock_movements WHERE id = ?').bind(id),
  ])
  return json({ reversed: true, id, product_id: movement.product_id, balance_after: balanceAfter })
}
