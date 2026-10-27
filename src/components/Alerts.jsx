import { useCallback, useEffect, useState } from 'react'
import { api, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { Button, Card, Empty, Loading, StatusBadge, useToast } from './ui.jsx'
import { useAuth } from '../auth.jsx'
import { ProductImage } from './ProductImage.jsx'

export default function Alerts({ refreshKey, onChanged }) {
  const { can } = useAuth()
  const mayRestock = can('move')
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [urgency, setUrgency] = useState('')
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.alerts())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshKey])

  // "Suggested order" tops the product back up to roughly 2x its reorder level.
  const suggested = (item) => Math.max(item.reorder_level * 2 - item.quantity, 1)

  const items = (data?.items ?? []).filter((i) => (urgency ? i.status === urgency : true))

  async function restock(item) {
    setBusyId(item.id)
    try {
      await api.createMovement({
        product_id: item.id,
        type: 'in',
        quantity: suggested(item),
        reference: 'REORDER',
        note: `Restock triggered from low-stock alert (level ${item.reorder_level})`,
      })
      toast(`${item.sku} restocked with ${suggested(item)} ${item.unit}`)
      await load()
      onChanged?.()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (loading && !data) return <Loading rows={6} label="Loading alerts" />

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Low-stock alerts</h1>
            <p className="muted">Products at or below their reorder level, ordered by how urgently they need attention.</p>
          </div>
        </div>
        <div className="segmented">
          {[['', 'All'], ['out', 'Out of stock'], ['low', 'Low stock']].map(([value, label]) => (
            <button key={label} type="button" className={urgency === value ? 'active' : ''} onClick={() => setUrgency(value)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="stat-grid stat-grid-3">
        <div className="mini-stat tone-warn"><span>Products needing attention</span><strong>{nf.format(data?.summary.total ?? 0)}</strong></div>
        <div className="mini-stat tone-danger"><span>Completely out of stock</span><strong>{nf.format(data?.summary.out_of_stock ?? 0)}</strong></div>
        <div className="mini-stat"><span>Estimated restock cost</span><strong>{money(data?.summary.restock_cost ?? 0)}</strong></div>
      </div>

      <Card
        title="Reorder worklist"
        subtitle="Suggested quantity refills stock to twice the reorder level"
        actions={(
          <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'lowstock' })}>⤓ Export CSV</a>
        )}
        padded={false}
      >
        {error && <div className="pad"><p className="error-text">{error}</p></div>}
        {items.length === 0
          ? (
            <div className="pad">
              <Empty
                title={urgency ? 'No products in this state' : 'All stock levels are healthy'}
                hint={urgency ? 'Switch the filter to see other alerts.' : `Nothing is at or below its reorder level. Estimated restock cost is ${money(data?.summary.restock_cost ?? 0)}.`}
              />
            </div>
          )
          : (
            <div className="table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Status</th>
                    <th className="num">On hand</th>
                    <th className="num">Reorder at</th>
                    <th className="num">Coverage</th>
                    <th className="num">Suggested order</th>
                    <th className="num">Cost</th>
                    <th>Supplier</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="cell-product">
                          <ProductImage product={i} size={36} />
                          <span className="cell-product-copy">
                            <span className="cell-main">{i.name}</span>
                            <span className="muted small mono">{i.sku} · {i.category}{i.location ? ` · ${i.location}` : ''}</span>
                          </span>
                        </div>
                      </td>
                      <td><StatusBadge status={i.status} /></td>
                      <td className="num"><strong>{nf.format(i.quantity)}</strong> <span className="muted small">{i.unit}</span></td>
                      <td className="num muted">{nf.format(i.reorder_level)}</td>
                      <td className="num">
                        <span className={`coverage coverage-${i.coverage < 0.5 ? 'crit' : i.coverage < 1 ? 'warn' : 'ok'}`}>{i.coverage}×</span>
                      </td>
                      <td className="num">{nf.format(suggested(i))} {i.unit}</td>
                      <td className="num">{money(suggested(i) * i.cost_price)}</td>
                      <td className="small muted">{i.supplier || '—'}</td>
                      <td className="row-actions">
                        <Button
                          size="sm" variant="primary" onClick={() => restock(i)}
                          disabled={busyId === i.id || !mayRestock}
                          title={mayRestock ? undefined : 'Your role cannot record stock movements'}
                        >
                          {busyId === i.id ? 'Working…' : 'Restock'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </div>
  )
}
