// Cycle counting: snapshot what the system believes, record what was counted,
// then post the differences as one auditable batch of adjustments.
import { badRequest, csv, fail, json, money, notFound, pagination, readJson, requireString, toInt } from './lib.js'

const SCOPE_ALL = 'all'

/** `all`, or `category:Storage` — parsed into the WHERE that snapshots lines. */
function parseScope(scope) {
  const raw = String(scope || SCOPE_ALL).trim()
  if (!raw || raw === SCOPE_ALL) return { scope: SCOPE_ALL, clause: 'WHERE is_active = 1', params: [] }
  const [kind, ...rest] = raw.split(':')
  const value = rest.join(':').trim()
  if (kind !== 'category' || !value) throw badRequest('`scope` must be "all" or "category:<name>"')
  return {
    scope: `category:${value}`,
    clause: 'WHERE is_active = 1 AND category = ?',
    params: [value],
  }
}

const scopeLabel = (scope) => (scope === SCOPE_ALL ? 'Whole catalogue' : scope.replace(/^category:/, 'Category: '))

const nextReference = async (env) => {
  const year = new Date().getUTCFullYear()
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_counts').all()
  return `CNT-${year}-${String(1001 + (results?.[0]?.n ?? 0)).padStart(4, '0')}`
}

const COUNT_COLUMNS = 'c.id, c.reference, c.scope, c.status, c.notes, c.created_by, c.created_at, c.posted_at'

/** Line stats so a count header always agrees with its sheet. */
const LINE_STATS_SQL = `SELECT l.count_id,
      COUNT(*) AS lines,
      SUM(CASE WHEN l.counted_qty IS NULL THEN 1 ELSE 0 END) AS unchecked,
      SUM(CASE WHEN l.counted_qty IS NOT NULL AND l.counted_qty <> l.system_qty THEN 1 ELSE 0 END) AS variances,
      SUM(CASE WHEN l.counted_qty IS NOT NULL THEN l.counted_qty - l.system_qty ELSE 0 END) AS net_units,
      SUM(CASE WHEN l.counted_qty IS NOT NULL THEN ABS(l.counted_qty - l.system_qty) ELSE 0 END) AS gross_units
    FROM stock_count_lines l GROUP BY l.count_id`

const shapeCount = (row, stats = {}) => {
  const s = stats[row.id] ?? {}
  const lines = s.lines ?? 0
  const checked = lines - (s.unchecked ?? 0)
  return {
    ...row,
    scope_label: scopeLabel(row.scope),
    lines,
    unchecked: s.unchecked ?? 0,
    checked,
    variances: s.variances ?? 0,
    net_units: s.net_units ?? 0,
    gross_units: s.gross_units ?? 0,
    // Value of the discrepancy at unit cost, so variance has a money figure.
    variance_value: round2(s.gross_units_value ?? 0),
    completion: lines > 0 ? Math.round((checked / lines) * 100) : 0,
  }
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100

export async function listCounts(env, url) {
  const status = String(url.searchParams.get('status') || '').toLowerCase()
  const where = []
  const params = []
  if (status) {
    if (!['open', 'posted', 'cancelled'].includes(status)) throw badRequest('`status` must be open, posted or cancelled')
    where.push('c.status = ?')
    params.push(status)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { limit, page, offset } = pagination(url)

  const [countRow, rows, stats, open] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM stock_counts c ${clause}`).bind(...params),
    env.DB.prepare(`SELECT ${COUNT_COLUMNS} FROM stock_counts c ${clause} ORDER BY datetime(c.created_at) DESC, c.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset),
    env.DB.prepare(LINE_STATS_SQL),
    env.DB.prepare("SELECT COUNT(*) AS n FROM stock_counts WHERE status = 'open'"),
  ])
  // Variance value needs unit costs, which the plain stat query does not join.
  const { results: valued } = await env.DB.prepare(
    `SELECT l.count_id,
            SUM(CASE WHEN l.counted_qty IS NOT NULL THEN ABS(l.counted_qty - l.system_qty) * p.cost_price ELSE 0 END) AS gross_units_value
       FROM stock_count_lines l JOIN products p ON p.id = l.product_id GROUP BY l.count_id`,
  ).all()
  const valueMap = Object.fromEntries(valued.map((v) => [v.count_id, v]))
  const statMap = Object.fromEntries((stats.results ?? []).map((r) => [r.count_id, { ...r, ...(valueMap[r.count_id] ?? {}) }]))

  return json({
    items: (rows.results ?? []).map((r) => shapeCount(r, statMap)),
    total: countRow?.results?.[0]?.n ?? countRow?.n ?? 0,
    page, limit,
    pages: Math.max(1, Math.ceil((countRow?.results?.[0]?.n ?? 0) / limit)),
    open_counts: open.results?.[0]?.n ?? 0,
  })
}

export async function getCount(env, id) {
  const count = await env.DB.prepare(`SELECT ${COUNT_COLUMNS} FROM stock_counts c WHERE c.id = ?`).bind(id).first()
  if (!count) throw notFound(`Stock count ${id} not found`)
  const [lines, stats] = await env.DB.batch([
    env.DB.prepare(
      `SELECT l.id, l.product_id, l.sku, l.name, l.unit, l.system_qty, l.counted_qty, l.note,
              p.quantity AS on_hand, p.location, p.category, p.cost_price, p.updated_at,
              p.image_url, CASE WHEN p.image_data <> '' THEN 1 ELSE 0 END AS has_photo,
              CASE WHEN l.counted_qty IS NULL THEN NULL ELSE l.counted_qty - l.system_qty END AS variance,
              CASE WHEN l.counted_qty IS NULL THEN 0
                   ELSE ROUND(ABS(l.counted_qty - l.system_qty) * p.cost_price, 2) END AS variance_value
         FROM stock_count_lines l JOIN products p ON p.id = l.product_id
        WHERE l.count_id = ? ORDER BY l.sku COLLATE NOCASE`,
    ).bind(id),
    env.DB.prepare(LINE_STATS_SQL).bind(),
  ])
  const { results: valued } = await env.DB.prepare(
    `SELECT l.count_id,
            SUM(CASE WHEN l.counted_qty IS NOT NULL THEN ABS(l.counted_qty - l.system_qty) * p.cost_price ELSE 0 END) AS gross_units_value
       FROM stock_count_lines l JOIN products p ON p.id = l.product_id
      WHERE l.count_id = ? GROUP BY l.count_id`,
  ).bind(id).all()
  const statMap = Object.fromEntries((stats.results ?? []).map((r) => [r.count_id, { ...r, ...(valued[0] ?? {}) }]))
  return json({ count: shapeCount(count, statMap), lines: lines.results ?? [] })
}

export async function createCount(env, request, user) {
  const body = await readJson(request)
  const parsed = parseScope(body.scope)
  const notes = body.notes === undefined ? '' : requireString(body.notes, 'notes', { max: 1000, allowEmpty: true, fallback: '' })
  const reference = String(body.reference ?? '').trim() || await nextReference(env)
  const clash = await env.DB.prepare('SELECT id FROM stock_counts WHERE reference = ?').bind(reference).first()
  if (clash) throw fail(409, `Reference "${reference}" is already used`)

  // Snapshot what the system believes right now, so later movements do not
  // silently rewrite the variance this count is meant to reveal.
  const { results: products } = await env.DB.prepare(
    `SELECT id, sku, name, unit, quantity FROM products ${parsed.clause} ORDER BY sku COLLATE NOCASE`,
  ).bind(...parsed.params).all()
  if (!products.length) throw badRequest('No active products match that scope')

  const created = await env.DB.prepare(
    `INSERT INTO stock_counts (reference, scope, status, notes, created_by, created_at)
     VALUES (?, ?, 'open', ?, ?, datetime('now'))`,
  ).bind(reference, parsed.scope, notes, user?.email ?? '').run()
  const countId = created.meta?.last_row_id

  for (const p of products) {
    await env.DB.prepare(
      `INSERT INTO stock_count_lines (count_id, product_id, sku, name, unit, system_qty, counted_qty, note)
       VALUES (?, ?, ?, ?, ?, ?, NULL, '')`,
    ).bind(countId, p.id, p.sku, p.name, p.unit, p.quantity).run()
  }
  const built = await getCount(env, countId)
  return json(await built.json(), 201)
}

/** Record counted quantities. `null` clears a line back to "not counted yet". */
export async function updateCount(env, id, request) {
  const count = await env.DB.prepare('SELECT * FROM stock_counts WHERE id = ?').bind(id).first()
  if (!count) throw notFound(`Stock count ${id} not found`)
  if (count.status !== 'open') throw fail(409, `A ${count.status} count cannot be edited`)

  const body = await readJson(request)
  const raw = Array.isArray(body.lines) ? body.lines : []
  if (!raw.length) throw badRequest('`lines` must list at least one product')

  const { results: known } = await env.DB.prepare('SELECT product_id FROM stock_count_lines WHERE count_id = ?').bind(id).all()
  const knownIds = new Set(known.map((k) => k.product_id))

  const statements = []
  let updated = 0
  for (const entry of raw) {
    const productId = Number(entry?.product_id)
    if (!knownIds.has(productId)) throw notFound(`Product ${entry?.product_id} is not on this count`)
    const counted = entry.counted_qty === null || entry.counted_qty === undefined || entry.counted_qty === ''
      ? null
      : toInt(entry.counted_qty, 'counted_qty', { min: 0, max: 10000000 })
    const note = entry.note === undefined ? undefined : requireString(entry.note, 'note', { max: 200, allowEmpty: true, fallback: '' })
    statements.push(
      env.DB.prepare(
        `UPDATE stock_count_lines SET counted_qty = ?, note = COALESCE(?, note)
          WHERE count_id = ? AND product_id = ?`,
      ).bind(counted, note ?? null, id, productId),
    )
    updated += 1
  }
  if (statements.length) await env.DB.batch(statements)
  const built = await getCount(env, id)
  const payload = await built.json()
  return json({ ...payload, updated })
}

/**
 * Post the count: one adjustment movement per discrepant line, all under the
 * count's reference so the whole session reverses as a unit in the ledger.
 */
export async function postCount(env, id, request) {
  const count = await env.DB.prepare('SELECT * FROM stock_counts WHERE id = ?').bind(id).first()
  if (!count) throw notFound(`Stock count ${id} not found`)
  if (count.status !== 'open') throw fail(409, `A ${count.status} count cannot be posted again`)

  const body = await readJson(request).catch(() => ({}))
  const { results: lines } = await env.DB.prepare(
    'SELECT * FROM stock_count_lines WHERE count_id = ?',
  ).bind(id).all()

  const counted = lines.filter((l) => l.counted_qty !== null && l.counted_qty !== undefined)
  if (!counted.length) throw badRequest('Nothing has been counted yet')
  // Unchecked lines are left alone; the caller may insist they are finished first.
  const unchecked = lines.length - counted.length
  if (unchecked > 0 && body.require_complete) {
    throw fail(409, `${unchecked} line(s) are still uncounted — finish them or post without requiring completion`)
  }

  const { results: products } = await env.DB.prepare(
    `SELECT id, quantity, cost_price, sale_price FROM products WHERE id IN (${counted.map(() => '?').join(',')})`,
  ).bind(...counted.map((l) => l.product_id)).all()
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]))

  const statements = []
  const adjustments = []
  for (const line of counted) {
    const product = productMap[line.product_id]
    if (!product) throw notFound(`Product ${line.sku} no longer exists`)
    const delta = line.counted_qty - product.quantity
    if (delta === 0) continue
    const movementType = delta > 0 ? 'in' : 'out'
    const cost = movementType === 'in' ? product.cost_price : product.sale_price
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(line.product_id, movementType, Math.abs(delta), cost, count.reference,
        line.note || `Cycle count ${count.reference}`, line.counted_qty),
    )
    statements.push(
      env.DB.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(line.counted_qty, line.product_id),
    )
    adjustments.push({ sku: line.sku, system_qty: product.quantity, counted_qty: line.counted_qty, variance: delta })
  }

  if (!adjustments.length) throw badRequest('Every counted line matches the system quantity — nothing to post')

  statements.push(
    env.DB.prepare("UPDATE stock_counts SET status = 'posted', posted_at = datetime('now') WHERE id = ?").bind(id),
  )
  await env.DB.batch(statements)

  const built = await getCount(env, id)
  const payload = await built.json()
  return json({
    count: payload.count,
    adjustments,
    posted: adjustments.length,
    net_units: adjustments.reduce((n, a) => n + a.variance, 0),
    unchecked,
  })
}

export async function deleteCount(env, id, url) {
  const mode = String(url.searchParams.get('mode') || 'archive')
  const count = await env.DB.prepare('SELECT * FROM stock_counts WHERE id = ?').bind(id).first()
  if (!count) throw notFound(`Stock count ${id} not found`)
  if (mode === 'purge') {
    if (count.status === 'posted') {
      throw fail(409, 'A posted count is part of the stock history — it cannot be deleted')
    }
    await env.DB.prepare('DELETE FROM stock_counts WHERE id = ?').bind(id).run()
    return json({ deleted: true, mode: 'purge', id })
  }
  if (count.status === 'open') {
    await env.DB.prepare("UPDATE stock_counts SET status = 'cancelled' WHERE id = ?").bind(id).run()
    return json({ deleted: true, mode: 'archive', id })
  }
  return json({ deleted: false, mode: 'archive', id, already: true })
}

/** CSV for the counts list, or one sheet's full detail with `id=`. */
export async function exportCountCsv(env, url) {
  const id = Number(url.searchParams.get('id') || 0)
  let rows = []
  let name = 'stock-counts'
  if (id) {
    const count = await env.DB.prepare('SELECT reference FROM stock_counts WHERE id = ?').bind(id).first()
    if (!count) throw notFound(`Stock count ${id} not found`)
    const { results } = await env.DB.prepare(
      `SELECT l.sku, l.name, l.unit, l.system_qty, l.counted_qty, p.quantity AS on_hand,
              CASE WHEN l.counted_qty IS NULL THEN NULL ELSE l.counted_qty - l.system_qty END AS variance,
              ROUND(COALESCE(ABS(l.counted_qty - l.system_qty), 0) * p.cost_price, 2) AS variance_value,
              l.note
         FROM stock_count_lines l JOIN products p ON p.id = l.product_id
        WHERE l.count_id = ? ORDER BY l.sku COLLATE NOCASE`,
    ).bind(id).all()
    name = `stock-count-${count.reference}`
    rows = [['SKU', 'Product', 'Unit', 'System qty', 'Counted qty', 'Variance', 'Value at cost', 'Note']]
    for (const r of results) {
      rows.push([r.sku, r.name, r.unit, r.system_qty, r.counted_qty ?? '', r.variance ?? '', money(r.variance_value), r.note])
    }
  } else {
    const { results } = await env.DB.prepare(
      `SELECT c.reference, c.scope, c.status, c.created_by, c.created_at, c.posted_at,
              COUNT(l.id) AS lines,
              SUM(CASE WHEN l.counted_qty IS NULL THEN 1 ELSE 0 END) AS unchecked,
              SUM(CASE WHEN l.counted_qty IS NOT NULL AND l.counted_qty <> l.system_qty THEN 1 ELSE 0 END) AS variances
         FROM stock_counts c LEFT JOIN stock_count_lines l ON l.count_id = c.id
        GROUP BY c.id ORDER BY datetime(c.created_at) DESC`,
    ).all()
    rows = [['Reference', 'Scope', 'Status', 'Counted by', 'Created', 'Posted', 'Lines', 'Unchecked', 'Variances']]
    for (const r of results) {
      rows.push([r.reference, scopeLabel(r.scope), r.status, r.created_by, r.created_at, r.posted_at ?? '', r.lines, r.unchecked, r.variances])
    }
  }
  return new Response(`\ufeff${csv(rows)}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
