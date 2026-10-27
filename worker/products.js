// Product catalog: CRUD, search/filter, and per-product movement history.
import { reportActivity, reportHealth } from './insights.js'
import {
  badRequest,
  cleanDate,
  cleanImageUrl,
  cleanStoredImage,
  base64ToBytes,
  productImageUrl,
  csv,
  fail,
  json,
  money,
  notFound,
  orderBy,
  pagination,
  readJson,
  requireString,
  toInt,
  toNumber,
} from './lib.js'

const STATUS_SQL = `CASE WHEN quantity <= 0 THEN 'out' WHEN quantity <= reorder_level THEN 'low' ELSE 'ok' END`

const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.category, p.description, p.image_url, p.unit,
  p.cost_price, p.sale_price, p.reorder_level, p.quantity, p.supplier, p.supplier_id, p.location,
  p.is_active, p.created_at, p.updated_at,
  CASE WHEN p.image_data <> '' THEN 1 ELSE 0 END AS has_photo,
  ${STATUS_SQL} AS status,
  ROUND(p.quantity * p.cost_price, 2) AS stock_value,
  ROUND(p.quantity * p.sale_price, 2) AS retail_value`

function shapeProduct(row, origin = '') {
  if (!row) return row
  const { has_photo, ...rest } = row
  return { ...rest, has_photo: has_photo ? 1 : 0, image_url: productImageUrl(row, origin) }
}

/** Match the free-text supplier name to a supplier record, when one exists. */
async function resolveSupplierId(env, name) {
  const value = String(name ?? '').trim()
  if (!value) return null
  const row = await env.DB.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE').bind(value).first()
  return row?.id ?? null
}

const SORTABLE = {
  name: 'p.name',
  sku: 'p.sku',
  category: 'p.category',
  quantity: 'p.quantity',
  value: 'stock_value',
  updated: 'p.updated_at',
  created: 'p.created_at',
  status: `CASE WHEN p.quantity <= 0 THEN 0 WHEN p.quantity <= p.reorder_level THEN 1 ELSE 2 END`,
}

const normaliseStatus = (raw) => {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  if (!['ok', 'low', 'out'].includes(s)) throw badRequest('`status` must be one of ok, low, out')
  return s
}

function listFilters(url) {
  const search = String(url.searchParams.get('search') || '').trim()

  const whereHasPhoto = (url, clause, params) => {
    if (url.searchParams.get('has_photo') === '1') {
      clause.push(`CASE WHEN p.image_data <> '' THEN 1 ELSE 0 END = 1`)
    }
  }
  const category = String(url.searchParams.get('category') || '').trim()
  const status = normaliseStatus(url.searchParams.get('status'))
  const active = String(url.searchParams.get('active') || '1')
  const where = []
  const params = []
  if (search) {
    // Escape LIKE wildcards so a literal % in a search term is not a wildcard.
    const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\' OR p.supplier LIKE ? ESCAPE '\\' OR p.location LIKE ? ESCAPE '\\')`)
    params.push(term, term, term, term, term)
  }
  if (category) {
    where.push('p.category = ?')
    params.push(category)
  }
  if (status) {
    where.push(`${STATUS_SQL} = ?`)
    params.push(status)
  }
  if (active !== 'all') {
    where.push('p.is_active = ?')
    params.push(active === '0' ? 0 : 1)
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

export async function listProducts(env, url) {
  if (url.searchParams.get('has_photo') === '1') {
    whereHasPhoto(url, where, params)
  }
  const { clause, params } = listFilters(url)
  const { limit, page, offset } = pagination(url)
  const order = orderBy(url.searchParams.get('sort'), SORTABLE, 'p.name ASC')

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM products p ${clause}`).bind(...params).first()
  const { results } = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products p ${clause} ${order} LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all()

  const total = countRow?.total ?? 0
  return json({
    items: (results ?? []).map((row) => shapeProduct(row)),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  })
}

export async function getProduct(env, id) {
  const product = await env.DB.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = ?`).bind(id).first()
  if (!product) throw notFound(`Product ${id} not found`)
  const recent = await env.DB.prepare(
    `SELECT id, type, quantity, unit_cost, reference, note, balance_after, created_at
     FROM stock_movements WHERE product_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 25`,
  ).bind(id).all()
  return json({ product: shapeProduct(product), movements: recent.results ?? [] })
}

function parseProductBody(body, { partial = false } = {}) {
  const out = {}
  const has = (key) => body[key] !== undefined && body[key] !== null

  if (has('sku') || !partial) out.sku = requireString(body.sku, 'sku', { max: 40 }).toUpperCase()
  if (has('name') || !partial) out.name = requireString(body.name, 'name', { max: 120 })
  if (has('category') || !partial) {
    out.category = requireString(body.category ?? 'Uncategorized', 'category', { max: 60 })
  }
  if (has('unit') || !partial) out.unit = requireString(body.unit ?? 'pcs', 'unit', { max: 20 })
  if (has('description')) out.description = requireString(body.description, 'description', { max: 1000, allowEmpty: true, fallback: '' })
  if (has('image_url')) {
    out.image_url = cleanImageUrl(body.image_url) ?? ''
    // Setting a link clears any uploaded bytes so one product has one picture.
    if (out.image_url) {
      out.image_data = ''
      out.image_type = ''
    }
  }
  if (has('image_data')) {
    const stored = cleanStoredImage(body.image_data, body.image_type)
    if (stored) {
      out.image_data = stored.data
      out.image_type = stored.type
      // An upload replaces a stored link, so one product keeps one picture.
      if (stored.data) out.image_url = ''
    }
  } else if (has('image_type') && !has('image_url')) {
    throw badRequest('`image_type` needs `image_data`')
  }
  if (has('supplier')) out.supplier = requireString(body.supplier, 'supplier', { max: 120, allowEmpty: true, fallback: '' })
  if (has('location')) out.location = requireString(body.location, 'location', { max: 120, allowEmpty: true, fallback: '' })
  if (has('cost_price') || !partial) out.cost_price = toNumber(body.cost_price, 'cost_price', { min: 0 })
  if (has('sale_price') || !partial) out.sale_price = toNumber(body.sale_price, 'sale_price', { min: 0 })
  if (has('reorder_level') || !partial) {
    out.reorder_level = toInt(body.reorder_level ?? 10, 'reorder_level', { min: 0, max: 1000000 })
  }
  if (has('quantity')) out.quantity = toInt(body.quantity, 'quantity', { min: 0, max: 100000000 })
  if (has('is_active')) out.is_active = body.is_active ? 1 : 0
  return out
}

export async function createProduct(env, request) {
  const body = await readJson(request)
  const fields = parseProductBody(body)
  if (fields.sale_price < fields.cost_price) {
    // Allowed (clearance pricing) but surfaced so the UI can warn.
  }
  const existing = await env.DB.prepare('SELECT id FROM products WHERE sku = ?').bind(fields.sku).first()
  if (existing) throw fail(409, `SKU "${fields.sku}" already exists`)

  const openingQty = fields.quantity ?? 0
  const result = await env.DB.prepare(
    `INSERT INTO products (sku, name, category, description, image_url, image_data, image_type, unit,
       cost_price, sale_price, reorder_level, quantity, supplier, supplier_id, location, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(
    fields.sku,
    fields.name,
    fields.category,
    fields.description ?? '',
    fields.image_url ?? '',
    fields.image_data ?? '',
    fields.image_type ?? '',
    fields.unit,
    fields.cost_price,
    fields.sale_price,
    fields.reorder_level,
    openingQty,
    fields.supplier ?? '',
    await resolveSupplierId(env, fields.supplier),
    fields.location ?? '',
    fields.is_active ?? 1,
  ).run()

  const id = result.meta?.last_row_id
  if (openingQty > 0) {
    await env.DB.prepare(
      `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
       VALUES (?, 'in', ?, ?, 'OPENING', 'Opening stock on product creation', ?, datetime('now'))`,
    ).bind(id, openingQty, fields.cost_price, openingQty).run()
  }
  const created = await env.DB.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = ?`).bind(id).first()
  return json({ product: shapeProduct(created) }, 201)
}

export async function updateProduct(env, id, request) {
  const current = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first()
  if (!current) throw notFound(`Product ${id} not found`)
  const fields = parseProductBody(await readJson(request), { partial: true })
  if (!Object.keys(fields).length) throw badRequest('No updatable fields provided')

  if (fields.sku && fields.sku !== current.sku) {
    const clash = await env.DB.prepare('SELECT id FROM products WHERE sku = ? AND id <> ?').bind(fields.sku, id).first()
    if (clash) throw fail(409, `SKU "${fields.sku}" already exists`)
  }

  // A quantity edit from the product form is still an auditable stock adjustment.
  const requestedQty = fields.quantity
  delete fields.quantity

  if (fields.supplier !== undefined) fields.supplier_id = await resolveSupplierId(env, fields.supplier)

  const merged = { ...current, ...fields }
  const assignments = Object.keys(fields).map((k) => `${k} = ?`)
  const values = Object.values(fields)
  assignments.push("updated_at = datetime('now')")
  await env.DB.prepare(`UPDATE products SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id).run()

  let adjusted = null
  if (requestedQty !== undefined && requestedQty !== current.quantity) {
    const delta = requestedQty - current.quantity
    const type = delta > 0 ? 'in' : 'out'
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'MANUAL-EDIT', 'Quantity corrected from product form', ?, datetime('now'))`,
      ).bind(id, type, Math.abs(delta), merged.cost_price, requestedQty),
      env.DB.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?").bind(requestedQty, id),
    ])
    adjusted = { type, quantity: Math.abs(delta), balance_after: requestedQty }
  }

  const product = await env.DB.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = ?`).bind(id).first()
  return json({ product: shapeProduct(product), adjustment: adjusted })
}

/** Default is archive (keeps movement history); ?mode=purge removes it for good. */
export async function deleteProduct(env, id, url) {
  const mode = String(url.searchParams.get('mode') || 'archive').toLowerCase()
  const current = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first()
  if (!current) throw notFound(`Product ${id} not found`)

  if (mode === 'purge') {
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run()
    return json({ deleted: true, mode: 'purge', id })
  }
  if (mode !== 'archive') throw badRequest('`mode` must be archive or purge')
  await env.DB.prepare("UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run()
  return json({ deleted: false, archived: true, id })
}

export async function restoreProduct(env, id) {
  const current = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first()
  if (!current) throw notFound(`Product ${id} not found`)
  await env.DB.prepare("UPDATE products SET is_active = 1, updated_at = datetime('now') WHERE id = ?").bind(id).run()
  const product = await env.DB.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = ?`).bind(id).first()
  return json({ restored: true, product })
}

export async function listCategories(env) {
  const { results } = await env.DB.prepare(
    `SELECT category,
            COUNT(*) AS products,
            COALESCE(SUM(quantity), 0) AS units,
            ROUND(COALESCE(SUM(quantity * cost_price), 0), 2) AS stock_value,
            SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
            SUM(CASE WHEN quantity > 0 AND quantity <= reorder_level THEN 1 ELSE 0 END) AS low_stock
     FROM products WHERE is_active = 1
     GROUP BY category ORDER BY category COLLATE NOCASE`,
  ).all()
  return json({ items: results ?? [] })
}

/**
 * Serve a product's uploaded photo. The bytes are read straight out of D1, so
 * the app needs no bucket and the image travels with the catalogue.
 */
export async function productImage(env, id) {
  const row = await env.DB.prepare('SELECT image_data, image_type FROM products WHERE id = ?').bind(id).first()
  if (!row || !row.image_data) throw notFound(`Product ${id} has no uploaded image`)
  const bytes = base64ToBytes(row.image_data)
  return new Response(bytes, {
    headers: {
      'content-type': row.image_type || 'image/jpeg',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** CSV export used by the reports screen. */
export async function exportCsv(env, url) {
  const type = String(url.searchParams.get('type') || 'products').toLowerCase()
  const from = cleanDate(url.searchParams.get('from'), 'from')
  const to = cleanDate(url.searchParams.get('to'), 'to')
  let rows = []
  let name = 'products'

  if (type === 'products' || type === 'valuation' || type === 'lowstock') {
    const { clause, params } = listFilters(url)
    const extra = type === 'lowstock' ? (clause ? `${clause} AND ${STATUS_SQL} IN ('low','out')` : `WHERE ${STATUS_SQL} IN ('low','out')`) : clause
    const { results } = await env.DB.prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM products p ${extra} ORDER BY p.category COLLATE NOCASE, p.name COLLATE NOCASE`,
    ).bind(...params).all()
    name = type === 'valuation' ? 'stock-valuation' : type
    rows = [[
      'SKU', 'Name', 'Category', 'Unit', 'Status', 'Quantity', 'Reorder Level',
      'Unit Cost', 'Unit Price', 'Stock Value', 'Retail Value', 'Supplier', 'Location', 'Image URL', 'Active',
    ]]
    for (const p of results ?? []) {
      rows.push([
        p.sku, p.name, p.category, p.unit, p.status, p.quantity, p.reorder_level,
        money(p.cost_price), money(p.sale_price), money(p.stock_value), money(p.retail_value),
        p.supplier, p.location, productImageUrl(p, url.origin), p.is_active ? 'yes' : 'no',
      ])
    }
  } else if (type === 'movements') {
    const where = []
    const params = []
    const pid = url.searchParams.get('product_id')
    if (pid) { where.push('m.product_id = ?'); params.push(Number(pid)) }
    if (from) { where.push('date(m.created_at) >= ?'); params.push(from) }
    if (to) { where.push('date(m.created_at) <= ?'); params.push(to) }
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.created_at, m.type, m.quantity, m.unit_cost, m.reference, m.note,
              m.balance_after, p.sku, p.name AS product_name, p.category, p.unit
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY datetime(m.created_at) DESC, m.id DESC LIMIT 5000`,
    ).bind(...params).all()
    name = 'stock-movements'
    rows = [['ID', 'Date', 'Type', 'SKU', 'Product', 'Category', 'Quantity', 'Unit', 'Unit Value', 'Reference', 'Note', 'Balance After']]
    for (const m of results ?? []) {
      rows.push([m.id, m.created_at, m.type, m.sku, m.product_name, m.category, m.quantity, m.unit, money(m.unit_cost), m.reference, m.note, m.balance_after])
    }
  } else if (type === 'health') {
    const report = await (await reportHealth(env, url)).json()
    name = 'inventory-health'
    rows = [['Metric', 'Value', 'Detail']]
    rows.push(['Health score', report.score.value, `${report.score.grade} · ${report.score.label}`])
    for (const dim of report.dimensions) rows.push([dim.label, dim.value, dim.hint])
    for (const [key, val] of Object.entries(report.kpis)) rows.push([key, val, ''])
    for (const row of report.aging) rows.push([row.label, row.value, `${row.products} products · ${row.share}% of value`])
  } else if (type === 'activity') {
    const report = await (await reportActivity(env, url)).json()
    name = 'movement-activity'
    rows = [['Week', 'Weekday', 'Movements', 'Units In', 'Units Out']]
    for (const c of report.cells) rows.push([c.week, c.weekday, c.movements, c.units_in, c.units_out])
    rows.push([])
    rows.push(['Hour', 'Movements', 'Units In', 'Units Out'])
    for (const h of report.hours) rows.push([`${String(h.hour).padStart(2, '0')}:00`, h.movements, h.units_in, h.units_out])
  } else if (type === 'categories') {
    const { results } = await env.DB.prepare(
      `SELECT category, COUNT(*) AS products, COALESCE(SUM(quantity), 0) AS units,
              ROUND(COALESCE(SUM(quantity * cost_price), 0), 2) AS stock_value
       FROM products WHERE is_active = 1 GROUP BY category ORDER BY category COLLATE NOCASE`,
    ).all()
    name = 'category-summary'
    rows = [['Category', 'Products', 'Units', 'Stock Value']]
    for (const c of results ?? []) rows.push([c.category, c.products, c.units, money(c.stock_value)])
  } else {
    throw badRequest('`type` must be products, movements, categories, valuation, lowstock, health or activity')
  }

  // Excel opens UTF-8 CSVs reliably only with a BOM.
  return new Response(`\ufeff${csv(rows)}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="inventory-${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
