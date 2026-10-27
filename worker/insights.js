// Dashboard KPIs, low-stock alerts and inventory reports.
import { badRequest, cleanDate, json, money, productImageUrl, toInt } from './lib.js'

const STATUS_SQL = `CASE WHEN quantity <= 0 THEN 'out' WHEN quantity <= reorder_level THEN 'low' ELSE 'ok' END`

const isoDay = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10)

/** Default reporting window when the caller does not supply one. */
function range(url, defaultDays = 30) {
  const to = cleanDate(url.searchParams.get('to'), 'to') || isoDay(0)
  const from = cleanDate(url.searchParams.get('from'), 'from') || isoDay(defaultDays - 1)
  if (from > to) throw badRequest('`from` must be on or before `to`')
  return { from, to }
}

function fillSeries(rows, from, to, keyOf) {
  const byKey = new Map(rows.map((r) => [r.bucket, r]))
  const out = []
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const bucket = d.toISOString().slice(0, 10)
    const row = byKey.get(bucket)
    out.push({ date: bucket, ...(row ? keyOf(row) : keyOf(null)) })
  }
  return out
}

export async function dashboard(env, url) {
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 14, 7), 90)
  const from = isoDay(days - 1)
  const today = isoDay(0)

  const [totals, alerts, trendRows, recent, categories, movers] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS products,
              SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_products,
              COALESCE(SUM(CASE WHEN is_active = 1 THEN quantity ELSE 0 END), 0) AS total_units,
              ROUND(COALESCE(SUM(CASE WHEN is_active = 1 THEN quantity * cost_price ELSE 0 END), 0), 2) AS stock_value,
              ROUND(COALESCE(SUM(CASE WHEN is_active = 1 THEN quantity * sale_price ELSE 0 END), 0), 2) AS retail_value,
              SUM(CASE WHEN is_active = 1 AND quantity <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN is_active = 1 AND quantity > 0 AND quantity <= reorder_level THEN 1 ELSE 0 END) AS low_stock,
              COALESCE(SUM(CASE WHEN is_active = 1 THEN reorder_level * cost_price ELSE 0 END), 0) AS reorder_cost
       FROM products`,
    ),
    env.DB.prepare(
      `SELECT id, sku, name, category, unit, quantity, reorder_level, cost_price, supplier, location,
              ${STATUS_SQL} AS status,
              CASE WHEN reorder_level > 0 THEN ROUND(quantity * 1.0 / reorder_level, 2) ELSE 0 END AS coverage
       FROM products WHERE is_active = 1 AND quantity <= reorder_level
       ORDER BY coverage ASC, name COLLATE NOCASE LIMIT 12`,
    ),
    env.DB.prepare(
      `SELECT date(created_at) AS bucket,
              COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity * unit_cost ELSE 0 END), 0) AS value_out
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?
       GROUP BY date(created_at) ORDER BY bucket`,
    ).bind(from, today),
    env.DB.prepare(
      `SELECT m.id, m.product_id, m.type, m.quantity, m.unit_cost, m.reference, m.note, m.balance_after,
              m.created_at, p.sku, p.name AS product_name, p.category, p.unit
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       ORDER BY datetime(m.created_at) DESC, m.id DESC LIMIT 10`,
    ),
    env.DB.prepare(
      `SELECT category, COUNT(*) AS products, COALESCE(SUM(quantity), 0) AS units,
              ROUND(COALESCE(SUM(quantity * cost_price), 0), 2) AS stock_value
       FROM products WHERE is_active = 1 GROUP BY category ORDER BY stock_value DESC`,
    ),
    env.DB.prepare(
      `SELECT p.id AS product_id, p.sku, p.name, p.category, p.unit,
              COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity ELSE 0 END), 0) AS units_out,
              COALESCE(SUM(CASE WHEN m.type = 'in' THEN m.quantity ELSE 0 END), 0) AS units_in,
              ROUND(COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity * m.unit_cost ELSE 0 END), 0), 2) AS revenue
       FROM products p JOIN stock_movements m ON m.product_id = p.id
       WHERE date(m.created_at) >= ?
       GROUP BY p.id ORDER BY units_out DESC LIMIT 8`,
    ).bind(isoDay(29)),
  ])

  const t = totals.results?.[0] ?? {}
  const outUnits = (trendRows.results ?? []).reduce((sum, r) => sum + r.units_out, 0)
  const inUnits = (trendRows.results ?? []).reduce((sum, r) => sum + r.units_in, 0)
  const valueOut = (trendRows.results ?? []).reduce((sum, r) => sum + r.value_out, 0)

  return json({
    generated_at: new Date().toISOString(),
    range: { from, to: today, days },
    kpis: {
      products: t.products ?? 0,
      active_products: t.active_products ?? 0,
      total_units: t.total_units ?? 0,
      stock_value: t.stock_value ?? 0,
      retail_value: t.retail_value ?? 0,
      margin_value: Math.round(((t.retail_value ?? 0) - (t.stock_value ?? 0)) * 100) / 100,
      low_stock: t.low_stock ?? 0,
      out_of_stock: t.out_of_stock ?? 0,
      reorder_cost: Math.round((t.reorder_cost ?? 0) * 100) / 100,
      units_in: inUnits,
      units_out: outUnits,
      value_out: Math.round(valueOut * 100) / 100,
      avg_daily_out: Math.round((outUnits / days) * 100) / 100,
    },
    trend: fillSeries(trendRows.results ?? [], from, today, (r) => ({
      units_in: r?.units_in ?? 0,
      units_out: r?.units_out ?? 0,
    })),
    alerts: alerts.results ?? [],
    recent: recent.results ?? [],
    categories: categories.results ?? [],
    top_movers: movers.results ?? [],
  })
}

export async function alerts(env, url) {
  const threshold = url.searchParams.get('threshold')
  const where = threshold !== null
    ? ['is_active = 1', 'quantity <= ?']
    : ['is_active = 1', 'quantity <= reorder_level']
  const params = threshold !== null ? [toInt(threshold, 'threshold', { min: 0 })] : []
  const { results } = await env.DB.prepare(
    `SELECT id, sku, name, category, unit, quantity, reorder_level, cost_price, sale_price,
            supplier, location, ${STATUS_SQL} AS status,
            CASE WHEN reorder_level > 0 THEN ROUND(quantity * 1.0 / reorder_level, 2) ELSE 0 END AS coverage,
            ROUND((reorder_level - quantity) * cost_price, 2) AS restock_cost
     FROM products WHERE ${where.join(' AND ')}
     ORDER BY coverage ASC, name COLLATE NOCASE`,
  ).bind(...params).all()
  const items = results ?? []
  return json({
    items,
    summary: {
      total: items.length,
      out_of_stock: items.filter((i) => i.status === 'out').length,
      low_stock: items.filter((i) => i.status === 'low').length,
      restock_cost: Math.round(items.reduce((s, i) => s + Math.max(0, i.restock_cost || 0), 0) * 100) / 100,
    },
  })
}

export async function reportSummary(env, url) {
  const { from, to } = range(url)
  const [totals, byType, daily, categories, top] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS movements,
              COUNT(DISTINCT product_id) AS products_moved,
              COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
              ROUND(COALESCE(SUM(CASE WHEN type = 'in' THEN quantity * unit_cost ELSE 0 END), 0), 2) AS value_in,
              ROUND(COALESCE(SUM(CASE WHEN type = 'out' THEN quantity * unit_cost ELSE 0 END), 0), 2) AS value_out
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT type, COUNT(*) AS movements, COALESCE(SUM(quantity), 0) AS units
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ? GROUP BY type`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT date(created_at) AS bucket,
              COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
              ROUND(COALESCE(SUM(CASE WHEN type = 'in' THEN quantity * unit_cost ELSE 0 END), 0), 2) AS value_in,
              ROUND(COALESCE(SUM(CASE WHEN type = 'out' THEN quantity * unit_cost ELSE 0 END), 0), 2) AS value_out
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?
       GROUP BY date(created_at) ORDER BY bucket`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT p.category,
              COUNT(DISTINCT p.id) AS products,
              COALESCE(SUM(CASE WHEN m.type = 'in' THEN m.quantity ELSE 0 END), 0) AS units_in,
              COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity ELSE 0 END), 0) AS units_out,
              ROUND(COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity * m.unit_cost ELSE 0 END), 0), 2) AS value_out
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       WHERE date(m.created_at) >= ? AND date(m.created_at) <= ?
       GROUP BY p.category ORDER BY units_out DESC`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT p.id AS product_id, p.sku, p.name, p.category, p.unit,
              COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity ELSE 0 END), 0) AS units_out,
              COALESCE(SUM(CASE WHEN m.type = 'in' THEN m.quantity ELSE 0 END), 0) AS units_in,
              ROUND(COALESCE(SUM(CASE WHEN m.type = 'out' THEN m.quantity * m.unit_cost ELSE 0 END), 0), 2) AS value_out
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       WHERE date(m.created_at) >= ? AND date(m.created_at) <= ?
       GROUP BY p.id ORDER BY units_out DESC LIMIT 10`,
    ).bind(from, to),
  ])

  const t = totals.results?.[0] ?? {}
  const spanDays = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1)
  const closed = (daily.results ?? []).filter((d) => d.units_out > 0)
  return json({
    range: { from, to, days: spanDays },
    totals: {
      movements: t.movements ?? 0,
      products_moved: t.products_moved ?? 0,
      units_in: t.units_in ?? 0,
      units_out: t.units_out ?? 0,
      net_units: (t.units_in ?? 0) - (t.units_out ?? 0),
      value_in: t.value_in ?? 0,
      value_out: t.value_out ?? 0,
      avg_daily_out: Math.round(((t.units_out ?? 0) / spanDays) * 100) / 100,
      busiest_day_units: closed.reduce((m, d) => Math.max(m, d.units_out), 0),
    },
    by_type: byType.results ?? [],
    daily: fillSeries(daily.results ?? [], from, to, (r) => ({
      units_in: r?.units_in ?? 0,
      units_out: r?.units_out ?? 0,
      value_in: r?.value_in ?? 0,
      value_out: r?.value_out ?? 0,
    })),
    categories: categories.results ?? [],
    top_products: top.results ?? [],
  })
}

/** Stock valuation report grouped by category and product. */
export async function reportValuation(env, url) {
  const category = String(url.searchParams.get('category') || '').trim()
  const clause = category ? 'WHERE p.is_active = 1 AND p.category = ?' : 'WHERE p.is_active = 1'
  const params = category ? [category] : []
  const [totals, byCategory, items] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS products, COALESCE(SUM(quantity), 0) AS units,
              ROUND(COALESCE(SUM(quantity * cost_price), 0), 2) AS cost_value,
              ROUND(COALESCE(SUM(quantity * sale_price), 0), 2) AS retail_value,
              ROUND(COALESCE(SUM(quantity * (sale_price - cost_price)), 0), 2) AS margin_value
       FROM products p ${clause}`,
    ).bind(...params),
    env.DB.prepare(
      `SELECT p.category, COUNT(*) AS products, COALESCE(SUM(p.quantity), 0) AS units,
              ROUND(COALESCE(SUM(p.quantity * p.cost_price), 0), 2) AS cost_value,
              ROUND(COALESCE(SUM(p.quantity * p.sale_price), 0), 2) AS retail_value
       FROM products p ${clause} GROUP BY p.category ORDER BY cost_value DESC`,
    ).bind(...params),
    env.DB.prepare(
      `SELECT p.id, p.sku, p.name, p.category, p.unit, p.quantity, p.cost_price, p.sale_price,
              p.reorder_level, p.image_url, p.updated_at,
              CASE WHEN p.image_data <> '' THEN 1 ELSE 0 END AS has_photo,
              ROUND(p.quantity * p.cost_price, 2) AS stock_value,
              ROUND(p.quantity * p.sale_price, 2) AS retail_value,
              ROUND(p.quantity * (p.sale_price - p.cost_price), 2) AS margin_value,
              ${STATUS_SQL} AS status
       FROM products p ${clause} ORDER BY stock_value DESC LIMIT 200`,
    ).bind(...params),
  ])
  const t = totals.results?.[0] ?? {}
  const marginPct = t.cost_value ? Math.round((((t.retail_value ?? 0) - t.cost_value) / t.cost_value) * 1000) / 10 : 0
  return json({
    totals: { ...t, margin_pct: marginPct },
    categories: byCategory.results ?? [],
    items: (items.results ?? []).map((row) => ({
      ...row,
      has_photo: row.has_photo ? 1 : 0,
      image_url: productImageUrl(row),
    })),
  })
}

/** Movement trend report, bucketed by day / week / month. */
export async function reportMovement(env, url) {
  const { from, to } = range(url, 30)
  const group = String(url.searchParams.get('group') || 'day').toLowerCase()
  const bucket =
    group === 'month' ? "strftime('%Y-%m', created_at)"
      : group === 'week' ? "strftime('%Y-W%W', created_at)"
        : 'date(created_at)'
  if (!['day', 'week', 'month'].includes(group)) throw badRequest('`group` must be day, week or month')

  const { results } = await env.DB.prepare(
    `SELECT ${bucket} AS bucket,
            COUNT(*) AS movements,
            COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in,
            COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
            ROUND(COALESCE(SUM(CASE WHEN type = 'in' THEN quantity * unit_cost ELSE 0 END), 0), 2) AS value_in,
            ROUND(COALESCE(SUM(CASE WHEN type = 'out' THEN quantity * unit_cost ELSE 0 END), 0), 2) AS value_out
     FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?
     GROUP BY bucket ORDER BY bucket`,
  ).bind(from, to).all()
  return json({ range: { from, to }, group, series: results ?? [] })
}

export const money2 = money
/* ------------------------------------------------------------------ health */

const clamp = (v, min = 0, max = 100) => Math.min(max, Math.max(min, v))
/** Currency for prose in the action list (the CSV helper stays bare numbers). */
const usd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0)

const AGING_ORDER = ['0-14', '15-30', '31-60', '61-90', '90+']
const AGING_LABEL = {
  '0-14': 'Fresh (0–14d)',
  '15-30': 'Active (15–30d)',
  '31-60': 'Cooling (31–60d)',
  '61-90': 'Stale (61–90d)',
  '90+': 'Dormant (90d+)',
}

/**
 * SaaS-style inventory health: a composite score with its dimensions, plus the
 * operational KPIs analysts expect (fill rate, cover, turnover, dead capital).
 */
export async function reportHealth(env, url) {
  const { from, to } = range(url, 30)
  const spanDays = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1)
  const deadCutoff = isoDay(29)

  const [stock, flow, aging, dead, categories] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS products,
              SUM(CASE WHEN quantity > reorder_level THEN 1 ELSE 0 END) AS healthy,
              SUM(CASE WHEN quantity > 0 AND quantity <= reorder_level THEN 1 ELSE 0 END) AS low,
              SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END) AS out,
              COALESCE(SUM(quantity), 0) AS units,
              ROUND(COALESCE(SUM(quantity * cost_price), 0), 2) AS value,
              ROUND(COALESCE(SUM(reorder_level * cost_price), 0), 2) AS reorder_cost
       FROM products WHERE is_active = 1`,
    ),
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
              COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in,
              COUNT(*) AS movements,
              COUNT(DISTINCT CASE WHEN type = 'out' THEN product_id END) AS shipped_products,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity * unit_cost ELSE 0 END), 0) AS value_out
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT bucket, COUNT(*) AS products, ROUND(COALESCE(SUM(value), 0), 2) AS value FROM (
         SELECT p.id,
                CASE WHEN j.last_out IS NULL THEN '90+'
                     WHEN (julianday('now') - julianday(j.last_out)) <= 14 THEN '0-14'
                     WHEN (julianday('now') - julianday(j.last_out)) <= 30 THEN '15-30'
                     WHEN (julianday('now') - julianday(j.last_out)) <= 60 THEN '31-60'
                     ELSE '61-90' END AS bucket,
                p.quantity * p.cost_price AS value
         FROM products p
         LEFT JOIN (SELECT product_id, MAX(date(created_at)) AS last_out
                    FROM stock_movements WHERE type = 'out' GROUP BY product_id) j ON j.product_id = p.id
         WHERE p.is_active = 1
       ) GROUP BY bucket`,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS products, ROUND(COALESCE(SUM(p.quantity * p.cost_price), 0), 2) AS value
       FROM products p
       WHERE p.is_active = 1 AND p.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM stock_movements m
                         WHERE m.product_id = p.id AND m.type = 'out' AND date(m.created_at) >= ?)`,
    ).bind(deadCutoff),
    env.DB.prepare(
      `SELECT category, COUNT(*) AS products, COALESCE(SUM(quantity), 0) AS units,
              ROUND(COALESCE(SUM(quantity * cost_price), 0), 2) AS value
       FROM products WHERE is_active = 1 GROUP BY category ORDER BY value DESC`,
    ),
  ])

  const s = stock.results?.[0] ?? {}
  const f = flow.results?.[0] ?? {}
  const d = dead.results?.[0] ?? {}
  const products = s.products ?? 0
  const healthy = s.healthy ?? 0
  const low = s.low ?? 0
  const out = s.out ?? 0
  const units = s.units ?? 0
  const value = s.value ?? 0
  const unitsOut = f.units_out ?? 0
  const avgDailyOut = unitsOut / spanDays
  const turnover = units > 0 ? unitsOut / units : 0
  const daysCover = avgDailyOut > 0 ? units / avgDailyOut : (units > 0 ? 365 : 0)
  const deadValue = d.value ?? 0
  const deadShare = pct(deadValue, value)
  const cats = categories.results ?? []
  const top3 = cats.slice(0, 3).reduce((sum, c) => sum + (c.value || 0), 0)
  const concentration = pct(top3, value)

  /* Composite health score: availability dominates, then movement, balance and
     concentration risk. Deliberately simple and explainable — each dimension is
     exposed so the UI can show why the score is what it is. */
  const dimensions = [
    {
      key: 'availability',
      label: 'Availability',
      value: clamp(Math.round(pct(healthy, products) + pct(low, products) * 0.55)),
      hint: `${healthy} of ${products} products above their reorder level`,
      weight: 0.35,
    },
    {
      key: 'movement',
      label: 'Movement',
      value: clamp(Math.round(turnover * 160)),
      hint: `${turnover.toFixed(2)}× stock turned over in ${spanDays} days`,
      weight: 0.3,
    },
    {
      key: 'freshness',
      label: 'Freshness',
      value: clamp(Math.round(100 - deadShare * 1.1)),
      hint: `${deadShare}% of capital has not moved in 30 days`,
      weight: 0.2,
    },
    {
      key: 'focus',
      label: 'Balance',
      value: clamp(Math.round(100 - Math.max(0, concentration - 45) * 1.4)),
      hint: `Top 3 categories hold ${concentration}% of stock value`,
      weight: 0.15,
    },
  ]
  const score = Math.round(dimensions.reduce((sum, dim) => sum + dim.value * dim.weight, 0))
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D'
  const gradeLabel = { A: 'Excellent', B: 'Healthy', C: 'Needs attention', D: 'At risk' }[grade]

  const agingByBucket = new Map((aging.results ?? []).map((r) => [r.bucket, r]))
  const agingRows = AGING_ORDER.map((bucket) => {
    const row = agingByBucket.get(bucket) ?? { products: 0, value: 0 }
    return {
      bucket,
      label: AGING_LABEL[bucket],
      products: row.products ?? 0,
      value: row.value ?? 0,
      share: pct(row.value ?? 0, value),
      stale: bucket === '61-90' || bucket === '90+',
    }
  })

  return json({
    generated_at: new Date().toISOString(),
    range: { from, to, days: spanDays },
    score: { value: score, grade, label: gradeLabel },
    kpis: {
      products,
      units,
      value,
      reorder_cost: s.reorder_cost ?? 0,
      units_in: f.units_in ?? 0,
      units_out: unitsOut,
      value_out: Math.round((f.value_out ?? 0) * 100) / 100,
      movements: f.movements ?? 0,
      shipped_products: f.shipped_products ?? 0,
      avg_daily_out: Math.round(avgDailyOut * 100) / 100,
      fill_rate: pct(healthy, products),
      stockout_rate: pct(out, products),
      low_stock_rate: pct(low, products),
      days_cover: Math.round(daysCover * 10) / 10,
      turnover: Math.round(turnover * 100) / 100,
      dead_products: d.products ?? 0,
      dead_value: deadValue,
      dead_share: deadShare,
      concentration,
    },
    dimensions,
    aging: agingRows,
    categories: cats.map((c) => ({ ...c, share: pct(c.value, value) })),
    actions: [
      out > 0 && { tone: 'danger', title: `Restock ${out} out-of-stock ${out === 1 ? 'line' : 'lines'}`, detail: 'Zero on hand — every sale is currently lost.', href: '#/alerts' },
      low > 0 && { tone: 'warn', title: `Review ${low} low-stock ${low === 1 ? 'line' : 'lines'}`, detail: `Below reorder level · ${usd(s.reorder_cost ?? 0)} to fully replenish.`, href: '#/alerts' },
      deadValue > 0 && { tone: 'info', title: `Free up ${usd(deadValue)} in dormant stock`, detail: `${d.products ?? 0} products have not shipped in 30 days.`, href: '#/reports' },
      concentration > 55 && { tone: 'info', title: `Diversify away from ${cats[0]?.category ?? 'your top category'}`, detail: `Top 3 categories hold ${concentration}% of stock value.`, href: '#/reports' },
    ].filter(Boolean),
  })
}

/* ---------------------------------------------------------------- activity */

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Movement intensity for the heatmap: week × weekday cells plus an hour-of-day
 * profile, which is what turns a movement log into a "when do we ship" story.
 */
export async function reportActivity(env, url) {
  const { from, to } = range(url, 56)

  const [cells, hours, weeks] = await env.DB.batch([
    env.DB.prepare(
      `SELECT strftime('%Y-W%W', created_at) AS week,
              CAST(strftime('%w', created_at) AS INTEGER) AS dow,
              COUNT(*) AS movements,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
              COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?
       GROUP BY week, dow ORDER BY week`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
              COUNT(*) AS movements,
              COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS units_out,
              COALESCE(SUM(CASE WHEN type = 'in' THEN quantity ELSE 0 END), 0) AS units_in
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?
       GROUP BY hour ORDER BY hour`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT DISTINCT strftime('%Y-W%W', created_at) AS week
       FROM stock_movements WHERE date(created_at) >= ? AND date(created_at) <= ?
       ORDER BY week`,
    ).bind(from, to),
  ])

  const weekList = (weeks.results ?? []).map((r) => r.week)
  const cellRows = (cells.results ?? []).map((r) => ({
    week: r.week,
    // SQLite %w counts Sunday as 0; re-index so the grid reads Mon → Sun.
    weekday: ((r.dow + 6) % 7) + 1,
    movements: r.movements,
    units_out: r.units_out,
    units_in: r.units_in,
  }))
  const byHour = new Map((hours.results ?? []).map((r) => [r.hour, r]))
  const hourSeries = Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour)
    return { hour, movements: row?.movements ?? 0, units_out: row?.units_out ?? 0, units_in: row?.units_in ?? 0 }
  })

  return json({
    range: { from, to },
    weekdays: WEEKDAY_LABELS.map((label, i) => ({ id: i + 1, label })),
    weeks: weekList,
    cells: cellRows,
    hours: hourSeries,
    max: {
      units_out: Math.max(1, ...cellRows.map((c) => c.units_out)),
      movements: Math.max(1, ...cellRows.map((c) => c.movements)),
      hourly_out: Math.max(1, ...hourSeries.map((h) => h.units_out)),
    },
    weekday_totals: WEEKDAY_LABELS.map((label, i) => ({
      label,
      units_out: cellRows.filter((c) => c.weekday === i + 1).reduce((s, c) => s + c.units_out, 0),
      movements: cellRows.filter((c) => c.weekday === i + 1).reduce((s, c) => s + c.movements, 0),
    })),
  })
}
