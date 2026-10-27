import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, dateTime, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Card, Empty, Field, Loading, Modal, Pagination, useToast } from './ui.jsx'
import { useAuth } from '../auth.jsx'

export const STATUS_LABEL = {
  draft: 'Draft', ordered: 'Ordered', partial: 'Part received',
  received: 'Received', cancelled: 'Cancelled',
}
const TABS = [['', 'All'], ['ordered', 'Ordered'], ['partial', 'Part received'], ['draft', 'Drafts'], ['received', 'Received']]

export default function Purchasing({ refreshKey, onChanged }) {
  const { can } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState('')
  const [filters, setFilters] = useState({ page: 1, limit: 20, search: '' })
  const [orders, setOrders] = useState(null)
  const [suggestions, setSuggestions] = useState(null)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState(null)

  const load = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([
        api.purchaseOrders({ ...filters, status: tab }),
        api.suggestions({ days: 30 }),
      ])
      setOrders(o)
      setSuggestions(s)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [filters, tab])

  useEffect(() => { load() }, [load, refreshKey])
  const patch = (next) => setFilters((p) => ({ ...p, ...next, page: next.page ?? 1 }))

  const open = orders?.items.filter((o) => o.status === 'ordered' || o.status === 'partial') ?? []
  const incoming = open.reduce((n, o) => n + o.outstanding_value, 0)

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Purchasing</h1>
            <p className="muted">Order what is running out, track what is on its way, receive it onto the shelf.</p>
          </div>
        </div>
        <div className="button-row">
          <a className="btn btn-default btn-sm" href={api.procurementExportUrl({ type: 'purchase-orders' })}>⤓ Orders</a>
          <a className="btn btn-default btn-sm" href={api.procurementExportUrl({ type: 'suggestions' })}>⤓ Replenishment</a>
          {can('manage') && <Button variant="primary" onClick={() => setCreating(true)}>+ New order</Button>}
        </div>
      </div>

      <div className="stat-grid stat-grid-4">
        <div className="mini-stat"><span>Open orders</span><strong>{nf.format(open.length)}</strong></div>
        <div className="mini-stat tone-accent"><span>Value on order</span><strong>{money(orders ? orders.items.filter((o) => ['ordered', 'partial'].includes(o.status)).reduce((n, o) => n + o.total_value, 0) : 0)}</strong></div>
        <div className="mini-stat tone-warn"><span>Incoming (outstanding)</span><strong>{money(incoming)}</strong></div>
        <div className="mini-stat"><span>Needs ordering</span><strong>{nf.format(suggestions?.to_order ?? 0)}</strong></div>
      </div>

      {error && <div className="pad"><p className="error-text">{error}</p></div>}

      <ReplenishmentCard
        data={suggestions}
        canOrder={can('move')}
        refreshKey={refreshKey}
        onOrdered={async (message) => { toast(message); await load(); onChanged?.() }}
        onError={(m) => toast(m, 'error')}
      />

      <Card padded={false} title="Purchase orders" subtitle="Every order you have raised, and where each one has got to">
        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="Order status">
            {TABS.map(([value, label]) => (
              <button
                key={value || 'all'} type="button" role="tab"
                aria-selected={tab === value}
                className={`tab ${tab === value ? 'active' : ''}`}
                onClick={() => setTab(value)}
              >
                {label}
                <span className="tab-count">{value ? (orders?.by_status?.[value] ?? 0) : (orders?.total ?? 0)}</span>
              </button>
            ))}
          </div>
          <div className="toolbar-right">
            <input
              type="search" placeholder="Search reference or supplier…" value={filters.search}
              onChange={(e) => patch({ search: e.target.value })} aria-label="Search orders"
            />
          </div>
        </div>

        {loadingSafe(orders) && <Loading rows={5} label="Loading orders" />}
        {orders && orders.items.length === 0 && (
          <div className="pad"><Empty title="No purchase orders here" hint="Build one from the replenishment list above, or raise one by hand." /></div>
        )}
        {orders && orders.items.length > 0 && (
          <>
            <div className="table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th>Reference</th><th>Supplier</th><th>Status</th>
                    <th className="num">Progress</th><th className="num">Value</th>
                    <th>Expected</th><th>Raised</th><th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {orders.items.map((o) => (
                    <tr key={o.id}>
                      <td className="mono small"><strong>{o.reference}</strong></td>
                      <td>{o.supplier_name || <span className="muted">—</span>}</td>
                      <td><span className={`badge badge-${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span></td>
                      <td className="num">
                        <span className="progress" aria-label={`${o.progress}% received`}>
                          <span className="progress-fill" style={{ width: `${o.progress}%` }} data-tone={o.progress === 100 ? 'ok' : 'accent'} />
                        </span>
                        <span className="muted small"> {o.received_units}/{o.ordered_units}</span>
                      </td>
                      <td className="num">{money(o.total_value)}</td>
                      <td className="small muted">{o.expected_at || '—'}</td>
                      <td className="small muted">{dateTime(o.created_at)}</td>
                      <td className="row-actions">
                        <button type="button" className="link-btn" onClick={() => setDetail(o)}>Open</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="muted small">Cancelled orders are hidden unless you filter for them.</span>
              <Pagination page={orders.page} pages={orders.pages} total={orders.total} limit={orders.limit} onPage={(page) => setFilters((p) => ({ ...p, page }))} />
            </div>
          </>
        )}
      </Card>

      {creating && (
        <OrderForm
          onCancel={() => setCreating(false)}
          onDone={async (message) => { setCreating(false); toast(message); await load(); onChanged?.() }}
          onError={(m) => toast(m, 'error')}
        />
      )}

      {detail && (
        <OrderDetail
          orderId={detail.id}
          canReceive={can('move')}
          canManage={can('manage')}
          onClose={() => setDetail(null)}
          onChanged={async (message) => { if (message) toast(message); await load(); onChanged?.() }}
          onError={(m) => toast(m, 'error')}
        />
      )}
    </div>
  )
}

const loadingSafe = (data) => !data

/* --------------------------------------------------------- replenishment -- */

function ReplenishmentCard({ data, canOrder, onOrdered, onError }) {
  const [picked, setPicked] = useState({})
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => { setPicked({}) }, [data?.window_days, data?.cover_days])

  if (!data) return <Card title="Replenishment" subtitle="Working out what needs ordering…"><Loading rows={4} label="Analysing demand" /></Card>

  const rows = showAll ? data.items : data.items.filter((i) => i.state !== 'ok')
  const selected = data.items.filter((i) => picked[i.id] && i.suggested_qty > 0)
  const selectedValue = selected.reduce((n, i) => n + i.order_value, 0)

  async function orderSelected() {
    if (!selected.length) return onError('Tick the products you want to order first')
    setBusy(true)
    try {
      const res = await api.orderSuggestions({ product_ids: selected.map((i) => i.id) })
      onOrdered(`${res.orders} purchase order(s) raised across ${res.lines} line(s) — open them below to send`)
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Replenishment"
      subtitle={`Demand over the last ${data.window_days} days against each supplier's ${data.cover_days}-day cover window`}
      padded={false}
      actions={(
        <>
          <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show what needs attention' : `Show all ${data.items.length} products`}
          </button>
          {canOrder && (
            <Button size="sm" variant="primary" onClick={orderSelected} disabled={busy || !selected.length}>
              {busy ? 'Raising…' : `Order selected (${selected.length})`}
            </Button>
          )}
        </>
      )}
    >
      {data.needs_attention === 0 ? (
        <div className="pad">
          <Empty
            title="Nothing needs ordering"
            hint={`Every product is above its reorder point. Tick “show all” to see the demand model behind that, or order from the list anyway.`}
          />
        </div>
      ) : (
        <>
          <div className="toolbar toolbar-plain">
            <div className="mini-stat tone-warn"><span>Below reorder point</span><strong>{nf.format(data.to_order)}</strong></div>
            <div className="mini-stat"><span>Units suggested</span><strong>{nf.format(data.suggested_units)}</strong></div>
            <div className="mini-stat tone-accent"><span>Suggested value</span><strong>{money(data.suggested_value)}</strong></div>
            {data.overdue > 0 && <div className="mini-stat tone-danger"><span>Cover shorter than lead time</span><strong>{nf.format(data.overdue)}</strong></div>}
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {canOrder && <th aria-label="Select" />}
                  <th>Product</th><th>Supplier</th><th className="num">On hand</th>
                  <th className="num">Cover</th><th className="num">Reorder at</th>
                  <th className="num">Order</th><th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} data-state={i.state}>
                    {canOrder && (
                      <td>
                        <input
                          type="checkbox" checked={Boolean(picked[i.id])} disabled={i.suggested_qty <= 0}
                          onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.checked }))}
                          aria-label={`Select ${i.name} for ordering`}
                        />
                      </td>
                    )}
                    <td>
                      <div className="cell-main">{i.name}</div>
                      <div className="muted small mono">{i.sku} · {i.category}</div>
                    </td>
                    <td className="small">
                      {i.supplier_name || <span className="muted">Unassigned</span>}
                      <div className="muted small">{i.lead_time_days}-day lead</div>
                    </td>
                    <td className="num">
                      <strong>{nf.format(i.on_hand)}</strong> <span className="muted small">{i.unit}</span>
                      {i.on_order > 0 && <div className="muted small">+{i.on_order} on order</div>}
                    </td>
                    <td className="num">
                      {i.days_of_cover === null
                        ? <span className="muted">no demand</span>
                        : <span className={i.days_of_cover < i.lead_time_days ? 'neg' : ''}>{nf.format(i.days_of_cover)} d</span>}
                    </td>
                    <td className="num">
                      {nf.format(i.threshold)}
                      {i.threshold_low && <div className="muted small">model says {i.reorder_point}</div>}
                    </td>
                    <td className="num">
                      {i.suggested_qty > 0 ? <strong>{nf.format(i.suggested_qty)}</strong> : <span className="muted">—</span>}
                      <div className="muted small">to reach {i.target_level}</div>
                    </td>
                    <td className="num">{i.order_value > 0 ? money(i.order_value) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-foot">
            <span className="muted small">
              “Order” fills the shelf back to twice the reorder point, using demand × lead time plus cover days.
            </span>
            {selected.length > 0 && <span className="muted small">Selected: <strong>{money(selectedValue)}</strong></span>}
          </div>
        </>
      )}
    </Card>
  )
}

/* --------------------------------------------------------- order builder -- */

function OrderForm({ onCancel, onDone, onError }) {
  const [form, setForm] = useState({ supplier_id: '', expected_at: '', notes: '' })
  const [suppliers, setSuppliers] = useState([])
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState([])
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.suppliers({ limit: 100 }).then((r) => setSuppliers(r.items)).catch(() => {}) }, [])

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      api.products({ search: query, limit: 8, active: '1' }).then((r) => { if (alive) setOptions(r.items) }).catch(() => {})
    }, 180)
    return () => { alive = false; clearTimeout(t) }
  }, [query])

  const total = lines.reduce((n, l) => n + l.quantity * l.unit_cost, 0)

  function addLine(p) {
    setLines((prev) => {
      const existing = prev.find((l) => l.product_id === p.id)
      if (existing) return prev.map((l) => (l.product_id === p.id ? { ...l, quantity: l.quantity + p.reorder_level || 1 } : l))
      // Seed the line with the product's own reorder level, a sane starting point.
      return [...prev, { product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, quantity: p.reorder_level || 1, unit_cost: p.cost_price, on_hand: p.quantity }]
    })
    setQuery('')
    setOptions([])
  }

  async function save(status) {
    if (!lines.length) return onError('Add at least one product line')
    setBusy(true)
    try {
      const res = await api.createPurchaseOrder({
        supplier_id: form.supplier_id ? Number(form.supplier_id) : undefined,
        expected_at: form.expected_at,
        notes: form.notes,
        status,
        lines: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost) })),
      })
      onDone(`${res.order.reference} created${status === 'ordered' ? ' and sent' : ' as a draft'}`)
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New purchase order"
      subtitle="Lines default to the product's reorder level; adjust cost before sending."
      onClose={onCancel}
      width={780}
      footer={(
        <>
          <span className="muted small">{lines.length} line(s) · {money(total)}</span>
          <span className="spacer" />
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => save('draft')} disabled={busy}>Save draft</Button>
          <Button variant="primary" onClick={() => save('ordered')} disabled={busy}>{busy ? 'Saving…' : 'Create & send'}</Button>
        </>
      )}
    >
      <div className="stack-sm">
        <div className="form-grid">
          <Field label="Supplier" hint="Defaults to the supplier most lines belong to">
            <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
              <option value="">Decide from the lines</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.lead_time_days}d</option>)}
            </select>
          </Field>
          <Field label="Expected date" hint="When the supplier says it will land">
            <input type="date" value={form.expected_at} onChange={(e) => setForm({ ...form, expected_at: e.target.value })} />
          </Field>
        </div>
        <Field label="Add a product">
          <input
            type="search" placeholder="Search by name or SKU…" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search products to order"
          />
        </Field>
        <ul className="picker">
          {options.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => addLine(p)}>
                <span><strong>{p.name}</strong> <span className="muted small">{p.sku}</span></span>
                <span className="muted small">{p.quantity} {p.unit} on hand · reorder at {p.reorder_level}</span>
              </button>
            </li>
          ))}
          {options.length === 0 && query && <li className="muted small pad">No active products match.</li>}
        </ul>

        {lines.length > 0 && (
          <div className="table-scroll">
            <table className="table table-compact">
              <thead><tr><th>Product</th><th className="num">On hand</th><th className="num">Order qty</th><th className="num">Unit cost</th><th className="num">Line total</th><th /></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.product_id}>
                    <td><div className="cell-main">{l.name}</div><div className="muted small mono">{l.sku}</div></td>
                    <td className="num muted">{nf.format(l.on_hand)} {l.unit}</td>
                    <td className="num">
                      <input
                        type="number" min="1" step="1" className="qty-input" value={l.quantity}
                        onChange={(e) => setLines(lines.map((x) => (x.product_id === l.product_id ? { ...x, quantity: e.target.value } : x)))}
                        aria-label={`Order quantity for ${l.name}`}
                      />
                    </td>
                    <td className="num">
                      <input
                        type="number" min="0" step="0.01" className="qty-input" value={l.unit_cost}
                        onChange={(e) => setLines(lines.map((x) => (x.product_id === l.product_id ? { ...x, unit_cost: e.target.value } : x)))}
                        aria-label={`Unit cost for ${l.name}`}
                      />
                    </td>
                    <td className="num">{money(Number(l.quantity) * Number(l.unit_cost))}</td>
                    <td><button type="button" className="link-btn" onClick={() => setLines(lines.filter((x) => x.product_id !== l.product_id))}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Field label="Notes">
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Quarter-end top-up" />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------- order view -- */

function OrderDetail({ orderId, canReceive, canManage, onClose, onChanged, onError }) {
  const [data, setData] = useState(null)
  const [receiving, setReceiving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setData(await api.purchaseOrder(orderId)); setError(null) } catch (e) { setError(e.message) }
  }, [orderId])

  useEffect(() => { load() }, [load])

  if (!data) return <Modal title="Purchase order" onClose={onClose}><Loading rows={4} label="Loading order" /></Modal>

  const o = data.order
  const outstanding = data.lines.reduce((n, l) => n + (l.quantity - l.received_qty), 0)
  const receiveable = ['ordered', 'partial'].includes(o.status)

  async function act(fn, message) {
    setBusy(true)
    try { await fn(); onChanged(message); await load() } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal
      title={o.reference}
      subtitle={`${o.supplier_name || 'No supplier'} · raised ${dateTime(o.created_at)}`}
      onClose={onClose}
      width={820}
      footer={(
        <>
          <span className={`badge badge-${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
          <span className="muted small">{money(o.total_value)} · {o.received_units}/{o.ordered_units} units</span>
          <span className="spacer" />
          {o.status === 'draft' && canManage && (
            <Button onClick={() => act(() => api.sendPurchaseOrder(o.id), `${o.reference} marked as sent`)} disabled={busy}>Send order</Button>
          )}
          {o.status === 'cancelled' && canManage && (
            <Button onClick={() => act(() => api.reopenPurchaseOrder(o.id), `${o.reference} reopened`)} disabled={busy}>Reopen</Button>
          )}
          {receiveable && canReceive && <Button variant="primary" onClick={() => setReceiving(true)} disabled={busy || outstanding === 0}>Receive goods</Button>}
          {['draft', 'ordered', 'partial'].includes(o.status) && canManage && (
            <Button onClick={() => act(() => api.deletePurchaseOrder(o.id), `${o.reference} cancelled`)} disabled={busy}>Cancel order</Button>
          )}
        </>
      )}
    >
      {error && <p className="error-text">{error}</p>}
      <div className="stack-sm">
        {o.expected_at && (
          <div className="detail-hero">
            <div className="detail-hero-copy">
              <div className="detail-hero-title">Expected {o.expected_at}</div>
              <div className="muted small">{outstanding} unit(s) still outstanding · {money(o.outstanding_value)} to land</div>
              {o.notes && <div className="muted small">{o.notes}</div>}
            </div>
          </div>
        )}

        <div className="table-scroll">
          <table className="table table-compact">
            <thead>
              <tr><th>Product</th><th className="num">Ordered</th><th className="num">Received</th>
                <th className="num">Outstanding</th><th className="num">Unit cost</th><th className="num">Line total</th><th className="num">On hand</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td><div className="cell-main">{l.name}</div><div className="muted small mono">{l.sku}</div></td>
                  <td className="num">{nf.format(l.quantity)}</td>
                  <td className="num">{nf.format(l.received_qty)}</td>
                  <td className="num">{l.quantity - l.received_qty > 0 ? <strong>{nf.format(l.quantity - l.received_qty)}</strong> : <span className="muted">—</span>}</td>
                  <td className="num">{money(l.unit_cost)}</td>
                  <td className="num">{money(l.quantity * l.unit_cost)}</td>
                  <td className="num muted">{nf.format(l.on_hand)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {receiving && (
        <ReceiveDialog
          order={o} lines={data.lines}
          onCancel={() => setReceiving(false)}
          onDone={async (message) => { setReceiving(false); onChanged(message); await load() }}
          onError={onError}
        />
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------- receiving -- */

function ReceiveDialog({ order, lines, onCancel, onDone, onError }) {
  const open = lines.filter((l) => l.quantity - l.received_qty > 0)
  const [qtys, setQtys] = useState(() => Object.fromEntries(open.map((l) => [l.id, l.quantity - l.received_qty])))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const chosen = open.filter((l) => Number(qtys[l.id]) > 0)
  const units = chosen.reduce((n, l) => n + Number(qtys[l.id]), 0)
  const value = chosen.reduce((n, l) => n + Number(qtys[l.id]) * l.unit_cost, 0)

  async function submit() {
    if (!chosen.length) return onError('Enter what arrived on at least one line')
    setBusy(true)
    try {
      const res = await api.receivePurchaseOrder(order.id, {
        note,
        lines: chosen.map((l) => ({ line_id: l.id, quantity: Number(qtys[l.id]) })),
      })
      const costNote = res.received.filter((r) => Math.abs(r.cost_after - r.cost_before) > 0.0001)
      onDone(
        `${res.applied_units} unit(s) received — order is now ${res.status}`
        + (costNote.length ? ` · cost updated on ${costNote.length} line(s)` : '')
        + (res.capped ? ' · over-ordered lines were capped' : ''),
      )
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Receive against ${order.reference}`}
      subtitle="Goods in: each line becomes a stock movement and rolls cost into a weighted average."
      onClose={onCancel}
      width={720}
      footer={(
        <>
          <span className="muted small">{units} unit(s) · {money(value)}</span>
          <span className="spacer" />
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Receiving…' : `Receive ${units} unit(s)`}</Button>
        </>
      )}
    >
      <div className="stack-sm">
        <div className="table-scroll">
          <table className="table table-compact">
            <thead><tr><th>Product</th><th className="num">Outstanding</th><th className="num">Receiving now</th><th className="num">Unit cost</th></tr></thead>
            <tbody>
              {open.map((l) => (
                <tr key={l.id}>
                  <td><div className="cell-main">{l.name}</div><div className="muted small mono">{l.sku}</div></td>
                  <td className="num">{nf.format(l.quantity - l.received_qty)}</td>
                  <td className="num">
                    <input
                      type="number" min="0" max={l.quantity - l.received_qty} step="1" className="qty-input"
                      value={qtys[l.id]}
                      onChange={(e) => setQtys((q) => ({ ...q, [l.id]: e.target.value }))}
                      aria-label={`Quantity received for ${l.name}`}
                    />
                    <button type="button" className="link-btn" onClick={() => setQtys((q) => ({ ...q, [l.id]: l.quantity - l.received_qty }))}>all</button>
                  </td>
                  <td className="num muted">{money(l.unit_cost)}</td>
                </tr>
              ))}
              {open.length === 0 && <tr><td colSpan={4} className="muted small pad">Every line on this order has been fully received.</td></tr>}
            </tbody>
          </table>
        </div>
        <Field label="Delivery note">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pallet 2 of 2 checked in" />
        </Field>
      </div>
    </Modal>
  )
}
