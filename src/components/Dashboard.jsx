import { useEffect, useMemo, useState } from 'react'
import { api, dateTime, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { ProductImage } from './ProductImage.jsx'
import {
  BarChart, Button, Card, ChartToggle, DonutChart, Empty, Gauge, Loading, RankBars, Reveal, RingStat,
  StatCard, StatusBadge,
} from './ui.jsx'

/** `days` selector -> the from/to window the PDF report expects. */
const isoRange = (days) => {
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)
  return { from: day(days - 1), to: day(0) }
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

export default function Dashboard({ onNavigate, refreshKey }) {
  const [days, setDays] = useState(14)
  const [chartType, setChartType] = useState('bars')
  const [data, setData] = useState(null)
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([api.dashboard({ days }), api.reportHealth({ to: new Date().toISOString().slice(0, 10) })])
      .then(([d, h]) => { setData(d); setHealth(h); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [days, refreshKey])

  // Running net change per day, used as the sparkline behind "Units on hand".
  const netSeries = useMemo(() => {
    let running = 0
    return (data?.trend ?? []).map((d) => {
      running += (d.units_in || 0) - (d.units_out || 0)
      return running
    })
  }, [data])

  if (loading && !data) return <Loading rows={6} label="Loading dashboard" />
  if (error) return <Card title="Dashboard unavailable"><p className="error-text">{error}</p></Card>

  const k = data.kpis
  const netTrend = k.units_in - k.units_out
  const marginShare = k.retail_value ? k.margin_value / k.retail_value : 0
  const severity = k.low_stock + k.out_of_stock ? k.out_of_stock / (k.low_stock + k.out_of_stock) : 0

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Inventory overview</h1>
            <p className="muted">
              Live position across {nf.format(k.active_products)} active products · updated {dateTime(data.generated_at)}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <a className="btn btn-primary btn-sm pdf-btn" href={api.reportUrl({ from: isoRange(days).from, to: isoRange(days).to })} download>
            <LogoMark size={16} className="pdf-btn-mark" /> PDF report
          </a>
          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r.days} type="button" className={days === r.days ? 'active' : ''} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard
          delay={0}
          label="Stock value (cost)"
          value={k.stock_value}
          format={(v) => money(v)}
          tone="accent"
          icon="💰"
          bar={marginShare}
          barTone="accent"
          hint={`Retail ${money(k.retail_value)} · margin ${money(k.margin_value)}`}
        />
        <StatCard
          delay={1}
          label="Units on hand"
          value={k.total_units}
          format={(v) => nf.format(Math.round(v))}
          icon="📦"
          hint={`Across ${nf.format(k.products)} products`}
          spark={netSeries}
        />
        <StatCard
          delay={2}
          label="Low stock"
          value={k.low_stock}
          format={(v) => nf.format(Math.round(v))}
          tone={k.low_stock ? 'warn' : 'default'}
          icon="⚠"
          bar={severity}
          barTone="danger"
          hint={`${nf.format(k.out_of_stock)} out of stock · restock ${money(k.reorder_cost)}`}
        />
        <StatCard
          delay={3}
          label={`Movement (${days}d)`}
          value={k.units_out}
          format={(v) => nf.format(Math.round(v))}
          icon="🔁"
          hint={`In ${nf.format(k.units_in)} · out value ${money(k.value_out)}`}
          trend={netTrend === 0 ? null : { dir: netTrend > 0 ? 'up' : 'down', text: `${nf.format(Math.abs(netTrend))} net` }}
          spark={data.trend.map((d) => d.units_out)}
        />
      </div>

      {health && (
        <Reveal delay={4}>
          <Card
            hero
            title="Inventory health"
            subtitle={`Grade ${health.score.grade} · ${health.score.label} — availability, movement, freshness and balance over ${health.range.days} days`}
            actions={<Button size="sm" onClick={() => onNavigate('reports')}>Open full report</Button>}
          >
            <div className="health-strip">
              <Gauge value={health.score.value} label="Health score" grade={`Grade ${health.score.grade}`} size={172} />
              <div className="ring-strip">
                <RingStat value={health.kpis.fill_rate} label="Fill rate" sub={`${nf.format(health.kpis.products)} active products`} tone="good" />
                <RingStat value={health.kpis.stockout_rate} label="Stockout rate" sub="Lines sitting at zero" tone={health.kpis.stockout_rate > 5 ? 'danger' : 'good'} />
                <RingStat value={health.kpis.days_cover} max={Math.max(90, Math.ceil(health.kpis.days_cover))} unit="d" label="Days of cover" sub={`${health.kpis.avg_daily_out} units/day out`} tone={health.kpis.days_cover < 14 ? 'danger' : 'accent'} />
                <RingStat value={health.kpis.turnover} max={Math.max(2, Math.ceil(health.kpis.turnover * 10) / 10)} unit="×" label="Stock turnover" sub={`${health.range.days}-day period`} tone="accent" />
              </div>
            </div>
          </Card>
        </Reveal>
      )}

      <div className="grid-2">
        <Card
          delay={4}
          title="Stock movement"
          subtitle={`Units received vs issued over the last ${days} days`}
          actions={(
            <>
              <ChartToggle value={chartType} onChange={setChartType} />
              <Button size="sm" onClick={() => onNavigate('stock')}>Record movement</Button>
            </>
          )}
        >
          <BarChart data={data.trend} height={230} type={chartType} />
        </Card>

        <Card
          delay={5}
          title="Low-stock alerts"
          subtitle="Products at or below their reorder level"
          actions={<Button size="sm" onClick={() => onNavigate('alerts')}>View all</Button>}
        >
          {data.alerts.length === 0
            ? <Empty title="Everything is above reorder level" hint="No action needed right now." />
            : (
              <ul className="alert-list">
                {data.alerts.map((a, i) => (
                  <li key={a.id} style={{ '--i': i }}>
                    <ProductImage product={a} size={30} />
                    <div>
                      <strong>{a.name}</strong>
                      <span className="muted small">{a.sku} · {a.category}{a.location ? ` · ${a.location}` : ''}</span>
                    </div>
                    <div className="alert-right">
                      <StatusBadge status={a.status} />
                      <span className="qty">{a.quantity} / {a.reorder_level} {a.unit}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </Card>
      </div>

      <div className="grid-3">
        <Card delay={6} title="Recent activity" subtitle="Latest stock movements" padded={false}>
          {data.recent.length === 0
            ? <div className="pad"><Empty title="No movements yet" /></div>
            : (
              <table className="table">
                <thead>
                  <tr><th>Product</th><th>Type</th><th className="num">Qty</th><th>When</th></tr>
                </thead>
                <tbody>
                  {data.recent.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div className="cell-product">
                          <ProductImage product={{ sku: m.sku, name: m.product_name, category: m.category }} size={28} />
                          <span className="cell-product-copy">
                            <span className="cell-main">{m.product_name}</span>
                            <span className="muted small">{m.sku}</span>
                          </span>
                        </div>
                      </td>
                      <td><span className={`chip chip-${m.type}`}>{m.type === 'in' ? 'Stock in' : 'Stock out'}</span></td>
                      <td className="num">{nf.format(m.quantity)}</td>
                      <td className="muted small">{dateTime(m.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>

        <Card delay={7} title="Stock value by category" subtitle={`Total on hand ${money(k.stock_value)}`}>
          <DonutChart
            items={data.categories.map((c) => ({ label: c.category, value: c.stock_value }))}
            total={k.stock_value}
            formatter={(v) => money(v)}
            centerLabel="Stock value"
          />
        </Card>

        <Card delay={8} title="Top movers" subtitle="Units issued in the last 30 days">
          <RankBars
            items={data.top_movers}
            valueKey="units_out"
            labelKey="name"
            formatter={(v) => `${nf.format(v)} units`}
            tone="warn"
            metaKey={(p) => `${money(p.revenue)} dispatched`}
          />
        </Card>
      </div>
    </div>
  )
}
