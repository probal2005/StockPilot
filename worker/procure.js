// Procurement: suppliers, purchase orders, receiving, and reorder intelligence.
import {
  badRequest, csv, fail, json, money, notFound, orderBy, pagination, readJson,
  requireString, toInt, toNumber,
} from './lib.js'

/* A purchase order can only be edited while it is still a draft, and only its
   open lines can be received against. */
const OPEN_STATUSES = "('draft','ordered','partial')"
const EDITABLE = new Set(['draft', 'cancelled'])

const nextReference = async (env) => {
  const year = new Date().getUTCFullYear()
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_orders').all()
  // 3101+ keeps generated references clear of anything a user types by hand.
  return `PO-${year}-${3101 + (results?.[0]?.n ?? 0)}`
}

/* ---------------------------------------------------------------- suppliers */

const SUPPLIER_COLUMNS = `s.id, s.name, s.contact, s.email, s.phone, s.lead_time_days,
  s.notes, s.is_active, s.created_at, s.updated_at`

export async function listSuppliers(env, url) {
  const search = String(url.searchParams.get('search') || '').trim()
  const active = String(url.searchParams.get('active') || '1')
  const where = []
  const params = []
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push("(s.name LIKE ? ESCAPE '\\' OR s.contact LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\')")
    params.push(term, term, term)
  }
  if (active === '1') where.push('s.is_active = 1')
  else if (active === '0') where.push('s.is_active = 0')
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { limit, page, offset } = pagination(url)
  const order = orderBy(url.searchParams.get('sort'), {
    name: 's.name', lead: 's.lead_time_days', updated: 's.updated_at',
  }, 's.name COLLATE NOCASE ASC')

  const [countRow, rows, coverage] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM suppliers s ${clause}`).bind(...params),
    env.DB.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers s ${clause} ${order} LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset),
    env.DB.prepare(
      `SELECT s.id,
              (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.is_active = 1) AS products,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ${OPEN_STATUSES}) AS open_orders,
              (SELECT COALESCE(SUM((l.quantity - l.received_qty) * l.unit_cost), 0)
                 FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
                WHERE po.supplier_id = s.id AND po.status IN ${OPEN_STATUSES}) AS outstanding_value
         FROM suppliers s`,
    ),
  ])
  const stats = Object.fromEntries((coverage.results ?? []).map((r) => [r.id, r]))
  const total = countRow?.results?.[0]?.n ?? countRow?.n ?? 0

  return json({
    items: (rows.results ?? []).map((r) => ({
      ...r, ...stats[r.id],
      outstanding_value: Math.round((stats[r.id]?.outstanding_value ?? 0) * 100) / 100,
    })),
    total, page, limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  })
}

export async function getSupplier(env, id) {
  const supplier = await env.DB.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers s WHERE s.id = ?`).bind(id).first()
  if (!supplier) throw notFound(`Supplier ${id} not found`)
  const [products, orders] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, sku, name, category, quantity, reorder_level, cost_price, unit
       FROM products WHERE supplier_id = ? ORDER BY name COLLATE NOCASE LIMIT 100`,
    ).bind(id),
    env.DB.prepare(
      `SELECT id, reference, status, expected_at, created_at, ordered_at
       FROM purchase_orders WHERE supplier_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 20`,
    ).bind(id),
  ])
  return json({ supplier, products: products.results ?? [], orders: orders.results ?? [] })
}

function parseSupplier(body, { partial = false } = {}) {
  const out = {}
  const has = (k) => body[k] !== undefined && body[k] !== null
  if (has('name') || !partial) out.name = requireString(body.name, 'name', { max: 120 })
  if (has('contact')) out.contact = requireString(body.contact, 'contact', { max: 120, allowEmpty: true, fallback: '' })
  if (has('email')) {
    const email = requireString(body.email, 'email', { max: 200, allowEmpty: true, fallback: '' })
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('`email` must be a valid address')
    out.email = email
  }
  if (has('phone')) out.phone = requireString(body.phone, 'phone', { max: 60, allowEmpty: true, fallback: '' })
  if (has('lead_time_days') || !partial) {
    out.lead_time_days = toInt(body.lead_time_days ?? 7, 'lead_time_days', { min: 0, max: 365 })
  }
  if (has('notes')) out.notes = requireString(body.notes, 'notes', { max: 1000, allowEmpty: true, fallback: '' })
  if (has('is_active')) out.is_active = body.is_active ? 1 : 0
  return out
}

export async function createSupplier(env, request) {
  const fields = parseSupplier(await readJson(request))
  const clash = await env.DB.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE').bind(fields.name).first()
  if (clash) throw fail(409, `A supplier named "${fields.name}" already exists`)

  const result = await env.DB.prepare(
    `INSERT INTO suppliers (name, contact, email, phone, lead_time_days, notes, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(fields.name, fields.contact ?? '', fields.email ?? '', fields.phone ?? '',
    fields.lead_time_days, fields.notes ?? '', fields.is_active ?? 1).run()
  const id = result.meta?.last_row_id

  // Any product already naming this supplier gets linked to the new record.
  const linked = await env.DB.prepare(
    'UPDATE products SET supplier_id = ? WHERE supplier = ? AND supplier_id IS NULL',
  ).bind(id, fields.name).run()

  const supplier = await env.DB.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers s WHERE s.id = ?`).bind(id).first()
  return json({ supplier, linked_products: linked.meta?.changes ?? 0 }, 201)
}

export async function updateSupplier(env, id, request) {
  const current = await env.DB.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first()
  if (!current) throw notFound(`Supplier ${id} not found`)
  const fields = parseSupplier(await readJson(request), { partial: true })
  if (!Object.keys(fields).length) throw badRequest('No updatable fields provided')

  if (fields.name && fields.name !== current.name) {
    const clash = await env.DB.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND id <> ?').bind(fields.name, id).first()
    if (clash) throw fail(409, `A supplier named "${fields.name}" already exists`)
    await env.DB.prepare('UPDATE products SET supplier = ? WHERE supplier_id = ?').bind(fields.name, id).run()
  }
  const assignments = Object.keys(fields).map((k) => `${k} = ?`)
  assignments.push("updated_at = datetime('now')")
  await env.DB.prepare(`UPDATE suppliers SET ${assignments.join(', ')} WHERE id = ?`)
    .bind(...Object.values(fields), id).run()
  const supplier = await env.DB.prepare(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers s WHERE s.id = ?`).bind(id).first()
  return json({ supplier })
}

export async function deleteSupplier(env, id, url) {
  const mode = String(url.searchParams.get('mode') || 'archive')
  const current = await env.DB.prepare('SELECT id, name, is_active FROM suppliers WHERE id = ?').bind(id).first()
  if (!current) throw notFound(`Supplier ${id} not found`)

  if (mode === 'purge') {
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE supplier_id = ?').bind(id).all()
    if ((results?.[0]?.n ?? 0) > 0) {
      throw fail(409, 'This supplier has purchase orders — archive it instead so the history stays intact')
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE products SET supplier_id = NULL WHERE supplier_id = ?').bind(id),
      env.DB.prepare('DELETE FROM suppliers WHERE id = ?').bind(id),
    ])
    return json({ deleted: true, mode: 'purge', id })
  }
  if (!current.is_active) return json({ deleted: false, mode: 'archive', id, already: true })
  await env.DB.prepare("UPDATE suppliers SET is_active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run()
  return json({ deleted: true, mode: 'archive', id })
}

/* --------------------------------------------------------- purchase orders */

const PO_COLUMNS = `po.id, po.reference, po.supplier_id, po.supplier_name, po.status,
  po.expected_at, po.notes, po.created_by, po.created_at, po.ordered_at,
  po.received_at, po.cancelled_at, po.updated_at`

/** Totals are derived from the lines so a header always agrees with its rows. */
const PO_TOTALS_SQL = `SELECT l.po_id,
         COUNT(*) AS lines,
         COALESCE(SUM(l.quantity), 0) AS ordered_units,
         COALESCE(SUM(l.received_qty), 0) AS received_units,
         COALESCE(SUM(l.quantity * l.unit_cost), 0) AS total_value,
         COALESCE(SUM((l.quantity - l.received_qty) * l.unit_cost), 0) AS outstanding_value
    FROM purchase_order_lines l GROUP BY l.po_id`

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100

const shapePo = (row, stats = {}) => {
  const s = stats[row.id] ?? {}
  const ordered = s.ordered_units ?? 0
  const received = s.received_units ?? 0
  return {
    ...row,
    lines: s.lines ?? 0,
    ordered_units: ordered,
    received_units: received,
    total_value: round2(s.total_value),
    outstanding_value: round2(s.outstanding_value),
    progress: ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0,
  }
}

export async function listPurchaseOrders(env, url) {
  const status = String(url.searchParams.get('status') || '').toLowerCase()
  const supplierId = Number(url.searchParams.get('supplier_id') || 0)
  const search = String(url.searchParams.get('search') || '').trim()
  const where = []
  const params = []
  if (status) {
    if (!['draft', 'ordered', 'partial', 'received', 'cancelled'].includes(status)) {
      throw badRequest('`status` must be draft, ordered, partial, received or cancelled')
    }
    where.push('po.status = ?')
    params.push(status)
  } else {
    where.push("po.status <> 'cancelled'") // cancelled only when explicitly asked for
  }
  if (supplierId) {
    where.push('po.supplier_id = ?')
    params.push(supplierId)
  }
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push("(po.reference LIKE ? ESCAPE '\\' OR po.supplier_name LIKE ? ESCAPE '\\' OR po.notes LIKE ? ESCAPE '\\')")
    params.push(term, term, term)
  }
  const clause = `WHERE ${where.join(' AND ')}`
  const { limit, page, offset } = pagination(url)
  const order = orderBy(url.searchParams.get('sort'), {
    date: 'datetime(po.created_at)', reference: 'po.reference',
    expected: 'date(po.expected_at)',
  }, 'datetime(po.created_at) DESC')

  const [countRow, rows, stats, byStatus] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_orders po ${clause}`).bind(...params),
    env.DB.prepare(`SELECT ${PO_COLUMNS} FROM purchase_orders po ${clause} ${order} LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset),
    env.DB.prepare(PO_TOTALS_SQL),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM purchase_orders GROUP BY status'),
  ])
  const total = countRow?.results?.[0]?.n ?? countRow?.n ?? 0
  const totalsByStatus = Object.fromEntries((byStatus.results ?? []).map((r) => [r.status, r.n]))
  const statMap = Object.fromEntries((stats.results ?? []).map((r) => [r.po_id, r]))

  return json({
    items: (rows.results ?? []).map((r) => shapePo(r, statMap)),
    total, page, limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    by_status: {
      draft: totalsByStatus.draft ?? 0,
      ordered: totalsByStatus.ordered ?? 0,
      partial: totalsByStatus.partial ?? 0,
      received: totalsByStatus.received ?? 0,
      cancelled: totalsByStatus.cancelled ?? 0,
    },
  })
}

export async function getPurchaseOrder(env, id) {
  const po = await env.DB.prepare(`SELECT ${PO_COLUMNS} FROM purchase_orders po WHERE po.id = ?`).bind(id).first()
  if (!po) throw notFound(`Purchase order ${id} not found`)
  const [lines, stats] = await env.DB.batch([
    env.DB.prepare(
      `SELECT l.id, l.product_id, l.sku, l.name, l.unit, l.quantity, l.received_qty, l.unit_cost,
              p.quantity AS on_hand, p.location, p.image_url, p.updated_at,
              CASE WHEN p.image_data <> '' THEN 1 ELSE 0 END AS has_photo,
              ROUND((l.quantity - l.received_qty) * l.unit_cost, 2) AS outstanding_value
         FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
        WHERE l.po_id = ? ORDER BY l.name COLLATE NOCASE`,
    ).bind(id),
    env.DB.prepare(PO_TOTALS_SQL),
  ])
  const statMap = Object.fromEntries((stats.results ?? []).map((r) => [r.po_id, r]))
  return json({ order: shapePo(po, statMap), lines: lines.results ?? [] })
}

/** Read the body, resolve every line against a real product, return the rows. */
async function parseLines(env, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw badRequest('`lines` must be a non-empty array of { product_id, quantity, unit_cost }')
  }
  if (rawLines.length > 200) throw badRequest('A purchase order carries at most 200 lines')
  const ids = [...new Set(rawLines.map((l) => Number(l?.product_id)).filter(Boolean))]
  if (!ids.length) throw badRequest('Every line needs a `product_id`')
  const placeholders = ids.map(() => '?').join(',')
  const { results } = await env.DB.prepare(
    `SELECT id, sku, name, unit, cost_price, supplier_id, is_active FROM products WHERE id IN (${placeholders})`,
  ).bind(...ids).all()
  const products = Object.fromEntries(results.map((p) => [p.id, p]))

  return rawLines.map((line) => {
    const product = products[Number(line?.product_id)]
    if (!product) throw notFound(`Product ${line?.product_id} not found`)
    if (!product.is_active) throw badRequest(`${product.sku} is archived and cannot be ordered`)
    const quantity = toInt(line.quantity, 'quantity', { min: 1, max: 1000000 })
    const unitCost = toNumber(line.unit_cost ?? product.cost_price, 'unit_cost', { min: 0 })
    return {
      product_id: product.id, sku: product.sku, name: product.name, unit: product.unit,
      supplier_id: product.supplier_id, quantity,
      unit_cost: Math.round(unitCost * 10000) / 10000,
    }
  })
}

/** The order's supplier: explicit, else the one most lines belong to. */
async function resolveSupplier(env, body, lines) {
  if (body.supplier_id) {
    const supplier = await env.DB.prepare('SELECT id, name FROM suppliers WHERE id = ?').bind(Number(body.supplier_id)).first()
    if (!supplier) throw notFound(`Supplier ${body.supplier_id} not found`)
    return supplier
  }
  const counts = {}
  for (const line of lines) {
    if (line.supplier_id) counts[line.supplier_id] = (counts[line.supplier_id] ?? 0) + line.quantity
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  if (best) {
    const supplier = await env.DB.prepare('SELECT id, name FROM suppliers WHERE id = ?').bind(Number(best)).first()
    if (supplier) return supplier
  }
  return { id: null, name: String(body.supplier_name ?? '').trim() }
}

export async function createPurchaseOrder(env, request, user) {
  const body = await readJson(request)
  const lines = await parseLines(env, body.lines)
  const supplier = await resolveSupplier(env, body, lines)
  const reference = String(body.reference ?? '').trim() || await nextReference(env)
  const existing = await env.DB.prepare('SELECT id FROM purchase_orders WHERE reference = ?').bind(reference).first()
  if (existing) throw fail(409, `Reference "${reference}" is already used`)

  const expectedAt = body.expected_at ? String(body.expected_at).trim() : ''
  if (expectedAt && !/^\d{4}-\d{2}-\d{2}$/.test(expectedAt)) throw badRequest('`expected_at` must be YYYY-MM-DD')
  const notes = body.notes === undefined ? '' : requireString(body.notes, 'notes', { max: 1000, allowEmpty: true, fallback: '' })
  const startOrdered = body.status === 'ordered'

  const created = await env.DB.prepare(
    `INSERT INTO purchase_orders (reference, supplier_id, supplier_name, status, expected_at, notes, created_by, created_at, ordered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ${startOrdered ? "datetime('now')" : 'NULL'}, datetime('now'))`,
  ).bind(reference, supplier.id ?? null, supplier.name ?? '', startOrdered ? 'ordered' : 'draft',
    expectedAt, notes, user?.email ?? '').run()
  const poId = created.meta?.last_row_id

  for (const line of lines) {
    await env.DB.prepare(
      `INSERT INTO purchase_order_lines (po_id, product_id, sku, name, unit, quantity, received_qty, unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(poId, line.product_id, line.sku, line.name, line.unit, line.quantity, line.unit_cost).run()
  }
  const built = await getPurchaseOrder(env, poId)
  return json(await built.json(), 201)
}

export async function updatePurchaseOrder(env, id, request) {
  const po = await env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first()
  if (!po) throw notFound(`Purchase order ${id} not found`)
  if (!EDITABLE.has(po.status)) {
    throw fail(409, `A ${po.status} purchase order cannot be edited — archive it or receive against it`)
  }
  const body = await readJson(request)

  const assignments = []
  const values = []
  if (body.expected_at !== undefined) {
    const expectedAt = String(body.expected_at ?? '').trim()
    if (expectedAt && !/^\d{4}-\d{2}-\d{2}$/.test(expectedAt)) throw badRequest('`expected_at` must be YYYY-MM-DD')
    assignments.push('expected_at = ?')
    values.push(expectedAt)
  }
  if (body.notes !== undefined) {
    assignments.push('notes = ?')
    values.push(requireString(body.notes, 'notes', { max: 1000, allowEmpty: true, fallback: '' }))
  }
  if (body.supplier_id !== undefined) {
    const supplier = await env.DB.prepare('SELECT id, name FROM suppliers WHERE id = ?').bind(Number(body.supplier_id)).first()
    if (!supplier) throw notFound(`Supplier ${body.supplier_id} not found`)
    assignments.push('supplier_id = ?', 'supplier_name = ?')
    values.push(supplier.id, supplier.name)
  }
  if (body.lines !== undefined) {
    const lines = await parseLines(env, body.lines)
    if (!lines.length || lines.reduce((n, l) => n + l.quantity, 0) <= 0) {
      throw badRequest('The order must carry at least one unit')
    }
    await env.DB.prepare('DELETE FROM purchase_order_lines WHERE po_id = ?').bind(id).run()
    for (const line of lines) {
      await env.DB.prepare(
        `INSERT INTO purchase_order_lines (po_id, product_id, sku, name, unit, quantity, received_qty, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).bind(id, line.product_id, line.sku, line.name, line.unit, line.quantity, line.unit_cost).run()
    }
  }
  if (assignments.length) {
    assignments.push("updated_at = datetime('now')")
    await env.DB.prepare(`UPDATE purchase_orders SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id).run()
  }
  return getPurchaseOrder(env, id)
}

/* -------------------------------------------------------------- transitions */

const TRANSITIONS = {
  order: { from: ['draft'], to: 'ordered', stamp: 'ordered_at' },
  cancel: { from: ['draft', 'ordered', 'partial'], to: 'cancelled', stamp: 'cancelled_at' },
  reopen: { from: ['cancelled'], to: 'draft', stamp: null },
}

export async function transitionPurchaseOrder(env, id, request, url) {
  const body = await readJson(request).catch(() => ({}))
  const action = String(body.action ?? url.searchParams.get('action') ?? '').toLowerCase()
  const rule = TRANSITIONS[action]
  if (!rule) throw badRequest('`action` must be order, cancel or reopen')

  const po = await env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first()
  if (!po) throw notFound(`Purchase order ${id} not found`)
  if (!rule.from.includes(po.status)) {
    throw fail(409, `A ${po.status} purchase order cannot be ${action === 'order' ? 'sent' : action === 'cancel' ? 'cancelled' : 'reopened'}`)
  }

  const assignments = ['status = ?', "updated_at = datetime('now')"]
  const values = [rule.to]
  if (rule.stamp) assignments.push(`${rule.stamp} = datetime('now')`)
  else assignments.push('ordered_at = NULL', 'cancelled_at = NULL')
  // Reopening keeps whatever delivery history the order had.
  await env.DB.prepare(`UPDATE purchase_orders SET ${assignments.join(', ')} WHERE id = ?`)
    .bind(...values, id).run()
  return getPurchaseOrder(env, id)
}

/* ---------------------------------------------------------------- receiving */

/**
 * Receive goods against a purchase order. Every accepted line becomes a stock-in
 * movement and rolls the product's cost into a new weighted average — the real
 * accounting behaviour a receiving note has to perform. Over-ordering is capped
 * to what is outstanding rather than failing the whole delivery.
 */
export async function receivePurchaseOrder(env, id, request) {
  const body = await readJson(request)
  const po = await env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first()
  if (!po) throw notFound(`Purchase order ${id} not found`)
  if (!['ordered', 'partial'].includes(po.status)) {
    throw fail(409, `A ${po.status} purchase order cannot be received against`)
  }

  const { results: lines } = await env.DB.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ?').bind(id).all()
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]))

  const raw = Array.isArray(body.lines) ? body.lines : []
  if (!raw.length) throw badRequest('`lines` must list what was received')
  const note = body.note === undefined ? '' : requireString(body.note, 'note', { max: 500, allowEmpty: true, fallback: '' })

  const productIds = [...new Set(raw.map((l) => Number(l?.line_id)).filter(Boolean).map((lineId) => byId[lineId]?.product_id).filter(Boolean))]
  const productMap = {}
  if (productIds.length) {
    const placeholders = productIds.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT id, quantity, cost_price FROM products WHERE id IN (${placeholders})`,
    ).bind(...productIds).all()
    for (const p of results) productMap[p.id] = p
  }

  const received = []
  const statements = []
  let capped = false

  for (const entry of raw) {
    const line = byId[Number(entry?.line_id)]
    if (!line) throw notFound(`Line ${entry?.line_id} is not on this purchase order`)
    const qty = toInt(entry.quantity ?? 0, 'quantity', { min: 0, max: 1000000 })
    if (qty === 0) continue
    const outstanding = line.quantity - line.received_qty
    if (qty > outstanding) { capped = true; continue }
    const unitCost = entry.unit_cost === undefined || entry.unit_cost === null
      ? line.unit_cost
      : toNumber(entry.unit_cost, 'unit_cost', { min: 0 })
    if (unitCost > 0 && Math.abs(unitCost - line.unit_cost) > 0.0001) capped = true

    const product = productMap[line.product_id]
    if (!product) throw notFound(`Product ${line.sku} no longer exists`)

    const costBefore = product.cost_price
    const newQty = product.quantity + qty
    // Weighted-average cost: blend what is on the shelf with what just landed.
    const newCost = newQty > 0 ? (product.quantity * product.cost_price + qty * unitCost) / newQty : unitCost
    const roundedCost = Math.round(newCost * 10000) / 10000

    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
         VALUES (?, 'in', ?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(line.product_id, qty, unitCost, po.reference, note || `Received against ${po.reference}`, newQty),
    )
    statements.push(
      env.DB.prepare("UPDATE products SET quantity = ?, cost_price = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(newQty, roundedCost, line.product_id),
    )
    statements.push(
      env.DB.prepare('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?').bind(qty, line.id),
    )
    // The map is mutated in place so two lines on one product compound correctly.
    product.quantity = newQty
    product.cost_price = roundedCost
    received.push({
      sku: line.sku, quantity: qty, unit_cost: unitCost,
      cost_before: costBefore, cost_after: roundedCost, on_hand: newQty,
    })
  }

  if (!received.length) {
    throw badRequest(capped ? 'Every line was over the outstanding quantity — nothing was received' : 'Nothing to receive')
  }

  // Recompute the order's status from the lines after this delivery.
  const orderedUnits = lines.reduce((n, l) => n + l.quantity, 0)
  const already = lines.reduce((n, l) => n + l.received_qty, 0)
  const willBe = already + received.reduce((n, r) => n + r.quantity, 0)
  const nextStatus = willBe >= orderedUnits ? 'received' : 'partial'

  statements.push(
    env.DB.prepare(
      `UPDATE purchase_orders SET status = ?,
              received_at = CASE WHEN ? = 'received' THEN datetime('now') ELSE received_at END,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(nextStatus, nextStatus, id),
  )
  await env.DB.batch(statements)

  const built = await getPurchaseOrder(env, id)
  const order = await built.json()
  return json({
    order: order.order,
    lines: order.lines,
    received,
    applied_units: received.reduce((n, r) => n + r.quantity, 0),
    status: nextStatus,
    capped,
  })
}

export async function deletePurchaseOrder(env, id, url) {
  const mode = String(url.searchParams.get('mode') || 'archive')
  const po = await env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first()
  if (!po) throw notFound(`Purchase order ${id} not found`)
  if (mode === 'purge') {
    if (!['draft', 'cancelled'].includes(po.status)) {
      throw fail(409, 'Only a draft or cancelled order can be deleted — cancel it first so the stock history stays intact')
    }
    await env.DB.prepare('DELETE FROM purchase_orders WHERE id = ?').bind(id).run()
    return json({ deleted: true, mode: 'purge', id })
  }
  // Archiving a live order means cancelling it, which is the honest end state.
  if (['draft', 'ordered', 'partial'].includes(po.status)) {
    return transitionPurchaseOrder(env, id, { action: 'cancel' }, url)
  }
  return json({ deleted: false, mode: 'archive', id, already: true })
}

/* -------------------------------------------- reorder intelligence --------- */

/** Units on order but not yet on the shelf, per product. */
const OUTSTANDING_BY_PRODUCT = `SELECT l.product_id, COALESCE(SUM(l.quantity - l.received_qty), 0) AS on_order
    FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
   WHERE po.status IN ('draft','ordered','partial') GROUP BY l.product_id`

const SUGGESTION_URL = 'http://local/api/purchasing/suggestions'

/**
 * Suggested replenishment, derived from real demand rather than a fixed
 * threshold: daily velocity × (the supplier's lead time + a cover window) sets
 * the reorder point, and the shelf is filled back up to twice that.
 */
export async function purchasingSuggestions(env, url) {
  const days = toInt(url.searchParams.get('days') ?? 30, 'days', { min: 1, max: 365 })
  const coverDays = toInt(url.searchParams.get('cover') ?? 7, 'cover', { min: 0, max: 90 })
  const [products, velocity, inbound] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.sku, p.name, p.category, p.unit, p.quantity, p.cost_price, p.sale_price,
              p.reorder_level, p.location, p.supplier_id, p.supplier, s.lead_time_days, s.name AS supplier_name
         FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.is_active = 1 ORDER BY p.name COLLATE NOCASE`,
    ),
    env.DB.prepare(
      `SELECT product_id, SUM(quantity) AS units_out FROM stock_movements
        WHERE type = 'out' AND datetime(created_at) >= datetime('now', ?)
        GROUP BY product_id`,
    ).bind(`-${days} days`),
    env.DB.prepare(OUTSTANDING_BY_PRODUCT),
  ])

  const velocityMap = Object.fromEntries(velocity.results.map((v) => [v.product_id, v.units_out]))
  const inboundMap = Object.fromEntries(inbound.results.map((v) => [v.product_id, v.on_order]))

  /* Two independent signals decide when to reorder, and either one firing is
     enough — the operator's own threshold (`reorder_level`), and the demand
     model (daily velocity over the supplier's lead time plus a cover window).
   */
  const items = products.results.map((p) => {
    const unitsOut = velocityMap[p.id] ?? 0
    const perDay = unitsOut / days
    const lead = p.lead_time_days ?? 7
    const onOrder = inboundMap[p.id] ?? 0
    const policy = p.reorder_level ?? 0
    const model = Math.ceil(perDay * (lead + coverDays))
    const threshold = Math.max(policy, model)
    // Fill the shelf back above both signals, not merely up to the gap.
    const orderUpTo = Math.max(threshold * 2, policy + model)
    const suggested = Math.max(0, Math.ceil(orderUpTo - p.quantity))
    const daysOfCover = perDay > 0 ? Math.round((p.quantity / perDay) * 10) / 10 : null
    const gap = Math.max(0, threshold - p.quantity)
    const state = p.quantity <= 0 || p.quantity <= threshold
      ? 'order'
      : p.quantity <= threshold * 1.25 ? 'watch' : 'ok'
    return {
      id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit, location: p.location,
      on_hand: p.quantity, reorder_level: policy,
      supplier_id: p.supplier_id, supplier_name: p.supplier_name ?? p.supplier ?? '', lead_time_days: lead,
      units_out: unitsOut, daily_demand: Math.round(perDay * 1000) / 1000,
      days_of_cover: daysOfCover,
      // `reorder_point` is the demand model; `reorder_level` is the policy.
      reorder_point: model, reorder_level_point: policy, threshold,
      target_level: orderUpTo,
      // True when demand alone says you should be holding more than the
      // threshold allows for — the prompt to raise the reorder level.
      threshold_low: model > policy,
      suggested_qty: suggested, on_order: onOrder,
      order_value: round2(suggested * p.cost_price),
      state, urgency: threshold > 0 ? round2(gap / threshold) : (p.quantity <= 0 ? 1 : 0),
    }
  })

  const toOrder = items.filter((i) => i.state === 'order' && i.suggested_qty > 0)
  return json({
    window_days: days, cover_days: coverDays,
    items,
    needs_attention: items.filter((i) => i.state !== 'ok').length,
    to_order: toOrder.length,
    suggested_units: toOrder.reduce((n, i) => n + i.suggested_qty, 0),
    suggested_value: round2(toOrder.reduce((n, i) => n + i.order_value, 0)),
    overdue: toOrder.filter((i) => i.days_of_cover !== null && i.days_of_cover < i.lead_time_days).length,
    thresholds_low: items.filter((i) => i.threshold_low).length,
  })
}

/**
 * Turn suggestions into real orders, grouped by supplier — so "order everything
 * recommended" produces one purchase order per vendor, ready to send.
 */
export async function createOrdersFromSuggestions(env, request, user) {
  const body = await readJson(request)
  const ids = Array.isArray(body.product_ids) ? body.product_ids.map(Number).filter(Boolean) : []
  if (!ids.length) throw badRequest('`product_ids` must list at least one product')
  if (ids.length > 100) throw badRequest('Order at most 100 products at a time')

  const all = await (await purchasingSuggestions(env, new URL(`${SUGGESTION_URL}?days=30`))).json()
  const wanted = all.items.filter((i) => ids.includes(i.id) && i.suggested_qty > 0)
  if (!wanted.length) throw badRequest('None of those products need ordering')

  const groups = {}
  for (const item of wanted) {
    const key = body.supplier_id ? `s${body.supplier_id}` : (item.supplier_id ? `s${item.supplier_id}` : 'none')
    ;(groups[key] ??= []).push(item)
  }

  const created = []
  for (const [key, items] of Object.entries(groups)) {
    const supplierId = key === 'none' ? null : Number(key.slice(1))
    const response = await createPurchaseOrder(env, new Request('http://local/api/purchase-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        supplier_id: supplierId,
        expected_at: body.expected_at ?? '',
        notes: body.notes || `Generated from replenishment suggestions — ${items.length} line(s)`,
        status: body.status === 'ordered' ? 'ordered' : 'draft',
        lines: items.map((i) => ({ product_id: i.id, quantity: i.suggested_qty })),
      }),
    }), user)
    created.push((await response.json()).order)
  }
  return json({
    created,
    orders: created.length,
    lines: created.reduce((n, o) => n + o.lines, 0),
  }, 201)
}

/** Purchasing KPIs for the dashboard: what is open, what is coming, what is late. */
export async function purchasingSummary(env, url) {
  const days = toInt(url.searchParams.get('days') ?? 30, 'days', { min: 1, max: 365 })
  const [open, overdue] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(t.total_value), 0) AS total_value,
              COALESCE(SUM(t.outstanding_value), 0) AS outstanding_value
         FROM purchase_orders po
         LEFT JOIN (${PO_TOTALS_SQL}) t ON t.po_id = po.id
        WHERE po.status IN ('ordered','partial')`,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS overdue FROM purchase_orders po
        WHERE po.status IN ('ordered','partial') AND po.expected_at IS NOT NULL
          AND date(po.expected_at) < date('now')`,
    ),
  ])
  const s = await (await purchasingSuggestions(env, new URL(`${SUGGESTION_URL}?days=${days}`))).json()
  return json({
    open_orders: open.results?.[0]?.orders ?? 0,
    open_value: round2(open.results?.[0]?.total_value),
    outstanding_value: round2(open.results?.[0]?.outstanding_value),
    overdue_orders: overdue.results?.[0]?.overdue ?? 0,
    needs_attention: s.needs_attention,
    to_order: s.to_order,
    suggested_units: s.suggested_units,
    suggested_value: s.suggested_value,
    overdue: s.overdue,
    window_days: days,
  })
}

/* ------------------------------------------------------------------- CSV -- */

/** Purchasing exports: suppliers, orders, order lines and the suggestion list. */
export async function exportProcureCsv(env, url) {
  const type = String(url.searchParams.get('type') || '').toLowerCase()
  let rows = []
  let name = type

  if (type === 'suppliers') {
    const { results } = await env.DB.prepare(
      `SELECT s.name, s.contact, s.email, s.phone, s.lead_time_days, s.is_active,
              (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.is_active = 1) AS products,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ${OPEN_STATUSES}) AS open_orders
         FROM suppliers s ORDER BY s.name COLLATE NOCASE`,
    ).all()
    name = 'suppliers'
    rows = [['Supplier', 'Contact', 'Email', 'Phone', 'Lead time (days)', 'Products', 'Open orders', 'Active']]
    for (const r of results ?? []) {
      rows.push([r.name, r.contact, r.email, r.phone, r.lead_time_days, r.products, r.open_orders, r.is_active ? 'yes' : 'no'])
    }
  } else if (type === 'purchase-orders') {
    const { results } = await env.DB.prepare(
      `SELECT po.reference, po.supplier_name, po.status, po.expected_at, po.created_at, po.ordered_at, po.received_at,
              t.lines, t.ordered_units, t.received_units, t.total_value, t.outstanding_value
         FROM purchase_orders po LEFT JOIN (${PO_TOTALS_SQL}) t ON t.po_id = po.id
        ORDER BY datetime(po.created_at) DESC`,
    ).all()
    name = 'purchase-orders'
    rows = [['Reference', 'Supplier', 'Status', 'Expected', 'Created', 'Sent', 'Received',
      'Lines', 'Units ordered', 'Units received', 'Order value', 'Outstanding value']]
    for (const r of results ?? []) {
      rows.push([r.reference, r.supplier_name, r.status, r.expected_at ?? '', r.created_at,
        r.ordered_at ?? '', r.received_at ?? '', r.lines ?? 0, r.ordered_units ?? 0, r.received_units ?? 0,
        money(r.total_value ?? 0), money(r.outstanding_value ?? 0)])
    }
  } else if (type === 'po-lines') {
    const reference = String(url.searchParams.get('reference') || '').trim()
    const where = reference ? 'WHERE po.reference = ?' : ''
    const params = reference ? [reference] : []
    const { results } = await env.DB.prepare(
      `SELECT po.reference, po.supplier_name, po.status, l.sku, l.name, l.quantity, l.received_qty,
              l.unit_cost, ROUND((l.quantity - l.received_qty) * l.unit_cost, 2) AS outstanding_value,
              p.quantity AS on_hand
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
         JOIN products p ON p.id = l.product_id
         ${where} ORDER BY po.reference, l.name COLLATE NOCASE`,
    ).bind(...params).all()
    name = 'po-lines'
    rows = [['Reference', 'Supplier', 'Status', 'SKU', 'Product', 'Ordered', 'Received',
      'Unit cost', 'Outstanding value', 'On hand']]
    for (const r of results ?? []) {
      rows.push([r.reference, r.supplier_name, r.status, r.sku, r.name, r.quantity, r.received_qty,
        money(r.unit_cost), money(r.outstanding_value), r.on_hand])
    }
  } else if (type === 'suggestions') {
    const s = await (await purchasingSuggestions(env, url)).json()
    name = 'replenishment'
    rows = [['SKU', 'Product', 'Category', 'Supplier', 'Lead time (days)', 'On hand', 'On order',
      'Daily demand', 'Days of cover', 'Reorder point', 'Suggested qty', 'Order value', 'State']]
    for (const i of s.items) {
      rows.push([i.sku, i.name, i.category, i.supplier_name, i.lead_time_days, i.on_hand, i.on_order,
        i.daily_demand, i.days_of_cover ?? '', i.reorder_point, i.suggested_qty, money(i.order_value), i.state])
    }
  } else {
    throw badRequest('`type` must be suppliers, purchase-orders, po-lines or suggestions')
  }

  return new Response(`\ufeff${csv(rows)}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
