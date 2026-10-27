import { useCallback, useEffect, useState } from 'react'
import { api, dayLabel, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import {
  Badge, BarChart, Button, Card, ChartToggle, Empty, Gauge, Heatmap, Loading, MeterList, MiniBars,
  RankBars, Reveal, RingStat, StackedBars, Treemap, Waterfall,
} from './ui.jsx'
import { ProductImage } from './ProductImage.jsx'

const iso = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10)
const PRESETS = [
  { label: 'Last 7 days', from: () => iso(6), to: () => iso(0) },
  { label: 'Last 30 days', from: () => iso(29), to: () => iso(0) },
  { label: 'Last 90 days', from: () => iso(89), to: () => iso(0) },
  { label: 'This month', from: () => `${iso(0).slice(0, 7)}-01`, to: () => iso(0) },
]

const STACK_KEYS = [
  { key: 'units_in', label: 'Stock in', tone: 'in', color: 'var(--c2)' },
  { key: 'units_out', label: 'Stock out', tone: 'out', color: 'var(--c5)' },
]

export default function Reports({ refreshKey }) {
  const [range, setRange] = useState({ from: iso(29), to: iso(0) })
  const [group, setGroup] = useState('day')
  const [chartType, setChartType] = useState('bars')
  const [summary, setSummary] = useState(null)
  const [valuation, setValuation] = useState(null)
  const [trend, setTrend] = useState(null)
  const [health, setHealth] = useState(null)
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, v, t, h, a] = await Promise.all([
        api.reportSummary(range),
        api.reportValuation({}),
        api.reportMovement({ ...range, group }),
        api.reportHealth(range),
        api.reportActivity(range),
      ])
      setSummary(s); setValuation(v); setTrend(t); setHealth(h); setActivity(a)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [range, group])

  useEffect(() => { load() }, [load, refreshKey])

  const t = summary?.totals
  const v = valuation?.totals
  const k = health?.kpis

  const buckets = group === 'day'
    ? (summary?.daily ?? []).slice(-21).map((d) => ({ label: dayLabel(d.date), ...d }))
    : (trend?.series ?? []).map((s) => ({ label: s.bucket, ...s }))

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Inventory intelligence</h1>
            <p className="muted">
              Health scoring, capital maps, activity heatmaps and throughput analytics — with CSV export.
            </p>
          </div>
        </div>
        <div className="button-row">
          <a className="btn btn-primary btn-sm pdf-btn" href={api.reportUrl({ ...range })} download>
            <LogoMark size={16} className="pdf-btn-mark" /> Download PDF report
          </a>
          <a className="btn btn-default btn-sm" href={api.reportUrl({ ...range, inline: 1 })} target="_blank" rel="noreferrer">Preview PDF</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'health', ...range })}>⤓ Health</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'activity', ...range })}>⤓ Activity</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'products', active: '1' })}>⤓ Products</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'valuation', active: '1' })}>⤓ Valuation</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'movements', ...range })}>⤓ Movements</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'categories' })}>⤓ Categories</a>
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'lowstock' })}>⤓ Low stock</a>
        </div>
      </div>

      <Card
        title="Reporting period"
        subtitle="Drives every visualisation, the PDF report and the CSV exports on this page"
      >
        <p className="pdf-note">
          <Badge tone="accent">PDF</Badge>
          The report is a six-page document: cover with the health score and key indicators, position &amp; valuation,
          movement analytics, attention &amp; actions with the restock worklist, a product gallery that renders the
          artwork of every item in the window, and a full product register.
        </p>
        <div className="toolbar toolbar-plain">
          <label className="inline-field">From <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="inline-field">To <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <div className="segmented">
            {PRESETS.map((p) => (
              <button
                key={p.label} type="button"
                className={range.from === p.from() && range.to === p.to() ? 'active' : ''}
                onClick={() => setRange({ from: p.from(), to: p.to() })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {error && <Card><p className="error-text">{error}</p></Card>}
      {loading && !summary && <Loading rows={6} label="Building reports" />}

      {health && (
        <Reveal>
          <Card
            hero
            title="Inventory health score"
            subtitle={`${health.score.grade} · ${health.score.label} — weighted availability, movement, freshness and balance over ${health.range.days} days`}
          >
            <div className="health-split">
              <div className="health-aside">
                <Gauge
                  value={health.score.value}
                  label="Health score"
                  grade={`Grade ${health.score.grade}`}
                  caption={health.score.label}
                />
                <span className="muted small">
                  {nf.format(k.products)} products · {money(k.value)} on hand · {k.days_cover} days cover
                </span>
              </div>
              <div className="stack-sm">
                <MeterList
                  items={health.dimensions.map((d) => ({
                    key: d.key,
                    label: d.label,
                    value: d.value,
                    tone: d.value >= 80 ? 'good' : d.value >= 55 ? 'warn' : 'danger',
                    hint: `${d.hint} · weight ${Math.round(d.weight * 100)}%`,
                  }))}
                />
                <div className="health-actions">
                  {health.actions.map((action, i) => (
                    <a key={action.title} className={`health-action health-action-${action.tone}`} href={action.href} style={{ '--i': i }}>
                      <i className="health-action-dot" aria-hidden="true" />
                      <span className="health-action-copy">
                        <strong>{action.title}</strong>
                        <span>{action.detail}</span>
                      </span>
                    </a>
                  ))}
                  {health.actions.length === 0 && (
                    <p className="muted small">No actions outstanding — stock levels, movement and capital are all in range.</p>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </Reveal>
      )}

      {k && (
        <Reveal delay={1}>
          <Card title="Operational KPIs" subtitle="The numbers a buyer or ops lead checks first">
            <div className="ring-strip">
              <RingStat value={k.fill_rate} label="Fill rate" sub={`${nf.format(k.products - Math.round(k.products * (k.stockout_rate + k.low_stock_rate) / 100))} products above reorder`} tone="good" />
              <RingStat value={k.stockout_rate} label="Stockout rate" sub={`${k.stockout_rate}% of lines at zero on hand`} tone={k.stockout_rate > 5 ? 'danger' : 'good'} />
              <RingStat value={k.low_stock_rate} label="Low-stock rate" sub={`${money(k.reorder_cost)} to replenish`} tone={k.low_stock_rate > 15 ? 'warn' : 'good'} />
              <RingStat value={k.days_cover} max={Math.max(90, Math.ceil(k.days_cover))} unit="d" label="Days of cover" sub={`${k.avg_daily_out} units/day out`} tone={k.days_cover < 14 ? 'danger' : k.days_cover > 120 ? 'warn' : 'good'} />
              <RingStat value={k.turnover} max={Math.max(2, Math.ceil(k.turnover * 10) / 10)} unit="×" label="Stock turnover" sub={`${health.range.days}-day period`} tone="accent" />
              <RingStat value={k.dead_share} label="Dormant capital" sub={`${money(k.dead_value)} idle in ${k.dead_products} products`} tone={k.dead_share > 20 ? 'warn' : 'good'} />
              <RingStat value={k.concentration} label="Top-3 category share" sub="Concentration risk" tone={k.concentration > 65 ? 'warn' : 'good'} />
            </div>
          </Card>
        </Reveal>
      )}

      {valuation && (
        <Reveal delay={2}>
          <div className="grid-2">
            <Card title="Capital map" subtitle="Where the stock value sits — area is proportional to cost value">
              <Treemap items={(health.categories ?? []).map((c) => ({ label: c.category, value: c.value }))} height={300} />
            </Card>
            <Card title="Stock ageing" subtitle="Capital by time since the last outgoing movement">
              <MeterList
                max={100}
                format={(val) => `${Math.round(val)}%`}
                items={(health.aging ?? []).map((a) => ({
                  key: a.bucket,
                  label: a.label,
                  value: a.share,
                  tone: a.bucket === '0-14' ? 'good' : a.stale ? 'danger' : 'warn',
                  valueLabel: `${money(a.value)} · ${a.share}%`,
                  hint: `${nf.format(a.products)} products · ${a.products === 0 ? 'nothing here' : `avg ${money(a.products ? a.value / a.products : 0)} each`}`,
                }))}
              />
            </Card>
          </div>
        </Reveal>
      )}

      {activity && (
        <Reveal delay={3}>
          <div className="grid-2">
            <Card title="Movement heatmap" subtitle={`Outgoing units per weekday × week, ${activity.range.from} → ${activity.range.to}`}>
              <Heatmap weeks={activity.weeks} weekdays={activity.weekdays} cells={activity.cells} valueKey="units_out" unit="units out" />
            </Card>
            <Card title="Hour-of-day profile" subtitle="When stock actually moves — useful for shift planning">
              <MiniBars
                data={activity.hours.map((h) => ({ label: `${String(h.hour).padStart(2, '0')}`, value: h.units_out }))}
                unit="units out"
                height={150}
              />
              <h4 className="sub-head">Weekday totals</h4>
              <MiniBars
                data={activity.weekday_totals.map((d) => ({ label: d.label, value: d.units_out }))}
                unit="units out"
                height={90}
              />
            </Card>
          </div>
        </Reveal>
      )}

      {t && (
        <Reveal delay={4}>
          <div className="grid-2">
            <Card title="Net stock movement" subtitle={`Cost-value flow, ${range.from} → ${range.to}`}>
              <WaterfallBlock summary={summary} onOpen={() => window.open(api.exportUrl({ type: 'movements', ...range }), '_blank')} />
            </Card>
            <Card
              title="In / out composition"
              subtitle={group === 'day' ? 'Last 21 days, stacked received vs issued' : `Grouped ${group} — received vs issued`}
            >
              <StackedBars data={buckets} keys={STACK_KEYS} height={250} />
            </Card>
          </div>
        </Reveal>
      )}

      {t && (
        <Reveal>
          <div className="stat-grid">
            <div className="mini-stat tone-accent"><span>Units received</span><strong>{nf.format(t.units_in)}</strong><small>{money(t.value_in)} at cost</small></div>
            <div className="mini-stat tone-warn"><span>Units issued</span><strong>{nf.format(t.units_out)}</strong><small>{money(t.value_out)} dispatched</small></div>
            <div className="mini-stat"><span>Net stock change</span><strong>{t.net_units >= 0 ? '+' : ''}{nf.format(t.net_units)}</strong><small>units over {t.days} days</small></div>
            <div className="mini-stat"><span>Average daily issue</span><strong>{nf.format(t.avg_daily_out)}</strong><small>busiest day {nf.format(t.busiest_day_units)} units</small></div>
          </div>
        </Reveal>
      )}

      {t && (
        <Reveal>
          <Card
            title="Movement trend"
            subtitle={`${t.movements} movements across ${t.products_moved} products · ${range.from} → ${range.to}`}
            actions={(
              <>
                {group === 'day' && <ChartToggle value={chartType} onChange={setChartType} />}
                <div className="segmented">
                  {[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']].map(([value, label]) => (
                    <button key={value} type="button" className={group === value ? 'active' : ''} onClick={() => setGroup(value)}>{label}</button>
                  ))}
                </div>
              </>
            )}
          >
            {group === 'day'
              ? <BarChart data={summary.daily} height={240} type={chartType} />
              : <StackedBars data={buckets} keys={STACK_KEYS} height={240} />}
          </Card>
        </Reveal>
      )}

      {t && v && (
        <Reveal>
          <div className="grid-2">
            <Card title="Stock valuation" subtitle={`Current on-hand value · ${nf.format(v.products)} active products`}>
            <div className="kv-grid">
              <div><span className="muted small">Cost value</span><strong>{money(v.cost_value)}</strong></div>
              <div><span className="muted small">Retail value</span><strong>{money(v.retail_value)}</strong></div>
              <div><span className="muted small">Potential margin</span><strong>{money(v.margin_value)}</strong></div>
              <div><span className="muted small">Margin rate</span><strong>{v.margin_pct}%</strong></div>
              <div><span className="muted small">Units on hand</span><strong>{nf.format(v.units)}</strong></div>
              <div><span className="muted small">Avg unit cost</span><strong>{money(v.units ? v.cost_value / v.units : 0)}</strong></div>
            </div>
            <h4 className="sub-head">Value by category</h4>
            <RankBars
              items={(valuation.categories ?? []).map((c) => ({ name: c.category, stock_value: c.cost_value }))}
              metaKey={(c) => `${nf.format(c.units)} units · retail ${money(c.retail_value)}`}
            />
          </Card>

            <Card title="Movement by category" subtitle={`Issued units, ${range.from} → ${range.to}`}>
              <RankBars
                items={summary.categories}
                valueKey="units_out"
                labelKey="category"
                formatter={(n) => `${nf.format(n)} units`}
                tone="warn"
                metaKey={(c) => `in ${nf.format(c.units_in)} · out ${money(c.value_out)}`}
              />
            </Card>
          </div>
        </Reveal>
      )}

      {t && (
        <Reveal>
          <Card title="Top products by throughput" subtitle={`Highest issued volume, ${range.from} → ${range.to}`} padded={false}>
            {summary.top_products.length === 0
              ? <div className="pad"><Empty title="No movements in this period" /></div>
              : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr><th>#</th><th>Product</th><th>Category</th><th className="num">Units in</th><th className="num">Units out</th><th className="num">Net</th><th className="num">Out value</th></tr>
                    </thead>
                    <tbody>
                      {summary.top_products.map((p, i) => (
                        <tr key={p.product_id}>
                          <td className="muted">{i + 1}</td>
                          <td>
                            <div className="cell-product">
                              <ProductImage product={{ sku: p.sku, name: p.name, category: p.category }} size={32} />
                              <div><div className="cell-main">{p.name}</div><div className="muted small mono">{p.sku}</div></div>
                            </div>
                          </td>
                          <td>{p.category}</td>
                          <td className="num">{nf.format(p.units_in)}</td>
                          <td className="num"><strong>{nf.format(p.units_out)}</strong> <span className="muted small">{p.unit}</span></td>
                          <td className={`num ${p.units_out - p.units_in > 0 ? 'neg' : 'pos'}`}>{p.units_in - p.units_out >= 0 ? '+' : ''}{nf.format(p.units_in - p.units_out)}</td>
                          <td className="num">{money(p.value_out)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
        </Reveal>
      )}

      {v && (
        <Reveal>
          <Card title="Top value holdings" subtitle="Products with the largest capital tied up in stock" padded={false}>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Product</th><th>Category</th><th className="num">Quantity</th><th className="num">Unit cost</th><th className="num">Stock value</th><th className="num">Retail value</th><th className="num">Margin</th><th>Status</th></tr>
              </thead>
              <tbody>
                {valuation.items.slice(0, 12).map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div className="cell-product">
                        <ProductImage product={i} size={32} />
                        <div><div className="cell-main">{i.name}</div><div className="muted small mono">{i.sku}</div></div>
                      </div>
                    </td>
                    <td>{i.category}</td>
                    <td className="num">{nf.format(i.quantity)} <span className="muted small">{i.unit}</span></td>
                    <td className="num">{money(i.cost_price)}</td>
                    <td className="num"><strong>{money(i.stock_value)}</strong></td>
                    <td className="num">{money(i.retail_value)}</td>
                    <td className="num pos">{money(i.margin_value)}</td>
                    <td><span className={`badge badge-${i.status}`}>{i.status === 'ok' ? 'In stock' : i.status === 'low' ? 'Low' : 'Out'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            <div className="table-foot">
              <span className="muted small">Showing the top 12 by value; export the valuation CSV for the full list.</span>
              <Button size="sm" onClick={() => window.open(api.exportUrl({ type: 'valuation', active: '1' }), '_blank')}>Open full valuation CSV</Button>
            </div>
          </Card>
        </Reveal>
      )}
    </div>
  )
}

/** In → out → net waterfall with the period's totals and an export shortcut. */
function WaterfallBlock({ summary, onOpen }) {
  const t = summary.totals
  const items = [
    { label: 'Received', value: t.value_in, type: 'in' },
    { label: 'Issued', value: t.value_out, type: 'out' },
    { label: 'Net', type: 'total' },
  ]
  const net = t.value_in - t.value_out
  return (
    <div className="stack-sm">
      <Waterfall items={items} height={240} formatter={money} />
      <div className="button-row">
        <span className="muted small">
          Net {net >= 0 ? 'increase' : 'decrease'} of <strong>{money(Math.abs(net))}</strong> in stock value over {t.days} days.
        </span>
        <Button size="sm" onClick={onOpen}>Open movements CSV</Button>
      </div>
    </div>
  )
}
