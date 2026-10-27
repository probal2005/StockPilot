import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, dateTime, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Card, Empty, Field, Loading, Modal, Pagination, useToast } from './ui.jsx'
import { useAuth } from '../auth.jsx'
import { ProductImage } from './ProductImage.jsx'

export default function Stock({ refreshKey, onChanged }) {
  const { can } = useAuth()
  const toast = useToast()
  const [filters, setFilters] = useState({ search: '', type: '', from: '', to: '', page: 1, limit: 25, sort: 'date', dir: 'desc' })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [dialog, setDialog] = useState(null) // 'in' | 'out' | 'adjust'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.movements(filters)
      setData(res)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { load() }, [load, refreshKey])

  const patch = (next) => setFilters((prev) => ({ ...prev, ...next, page: next.page ?? 1 }))

  const totals = data?.totals ?? { units_in: 0, units_out: 0 }

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Stock movements</h1>
            <p className="muted">Every unit in and out of the warehouse, with a full audit trail.</p>
          </div>
        </div>
        {can('move') ? (
          <div className="button-row">
            <Button variant="primary" onClick={() => setDialog('in')}>↓ Stock in</Button>
            <Button onClick={() => setDialog('out')}>↑ Stock out</Button>
            <Button onClick={() => setDialog('adjust')}>⚖ Adjust</Button>
          </div>
        ) : (
          <span className="role-note"><Badge tone="neutral">Viewer</Badge> read-only access</span>
        )}
      </div>

      <div className="stat-grid stat-grid-3">
        <div className="mini-stat"><span>Movements matched</span><strong>{nf.format(data?.total ?? 0)}</strong></div>
        <div className="mini-stat tone-accent"><span>Units received</span><strong>{nf.format(totals.units_in)}</strong></div>
        <div className="mini-stat tone-warn"><span>Units issued</span><strong>{nf.format(totals.units_out)}</strong></div>
      </div>

      <Card padded={false}>
        <div className="toolbar">
          <div className="search">
            <span aria-hidden="true">🔍</span>
            <input
              type="search" placeholder="Search product, SKU, reference or note…"
              value={filters.search} onChange={(e) => patch({ search: e.target.value })} aria-label="Search movements"
            />
          </div>
          <select value={filters.type} onChange={(e) => patch({ type: e.target.value })} aria-label="Filter by type">
            <option value="">All types</option>
            <option value="in">Stock in</option>
            <option value="out">Stock out</option>
          </select>
          <label className="inline-field">From <input type="date" value={filters.from} onChange={(e) => patch({ from: e.target.value })} /></label>
          <label className="inline-field">To <input type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} /></label>
          <div className="toolbar-right">
            <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'movements', from: filters.from, to: filters.to, product_id: filters.product_id })}>⤓ Export CSV</a>
          </div>
        </div>

        {error && <div className="pad"><p className="error-text">{error}</p></div>}
        {loading && !data && <Loading rows={8} label="Loading movements" />}
        {data && data.items.length === 0 && (
          <div className="pad"><Empty title="No movements in this view" hint="Adjust the filters or record a new stock movement." /></div>
        )}

        {data && data.items.length > 0 && (
          <>
            <div className="table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th><button type="button" className="th-sort" onClick={() => patch({ sort: 'date', dir: filters.dir === 'desc' ? 'asc' : 'desc' })}>When {filters.dir === 'desc' ? '↓' : '↑'}</button></th>
                    <th><button type="button" className="th-sort" onClick={() => patch({ sort: 'product' })}>Product</button></th>
                    <th>Type</th>
                    <th className="num">Quantity</th>
                    <th className="num">Balance after</th>
                    <th className="num">Unit value</th>
                    <th>Reference</th>
                    <th>Note</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.id}>
                      <td className="muted small">{dateTime(m.created_at)}</td>
                      <td>
                        <div className="cell-product">
                          <ProductImage product={{ sku: m.sku, name: m.product_name, category: m.category }} size={32} />
                          <span className="cell-product-copy">
                            <span className="cell-main">{m.product_name}</span>
                            <span className="muted small mono">{m.sku} · {m.category}</span>
                          </span>
                        </div>
                      </td>
                      <td><span className={`chip chip-${m.type}`}>{m.type === 'in' ? 'In' : 'Out'}</span></td>
                      <td className="num"><strong>{nf.format(m.quantity)}</strong> <span className="muted small">{m.unit}</span></td>
                      <td className="num">{nf.format(m.balance_after)}</td>
                      <td className="num">{money(m.unit_cost)}</td>
                      <td className="mono small">{m.reference || '—'}</td>
                      <td className="small muted">{m.note || '—'}</td>
                      <td className="row-actions">
                        <button
                          type="button" className="link-btn"
                          onClick={async () => {
                            if (!window.confirm(`Reverse movement #${m.id}? A compensating entry will be added.`)) return
                            try {
                              await api.deleteMovement(m.id)
                              toast(`Movement #${m.id} reversed`)
                              await load()
                              onChanged?.()
                            } catch (e) { toast(e.message, 'error') }
                          }}
                        >
                          Reverse
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="muted small">Audit entries are never edited — reversals add a compensating record.</span>
              <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={(page) => setFilters((p) => ({ ...p, page }))} />
            </div>
          </>
        )}
      </Card>

      {dialog && (
        <MovementDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onDone={async (message) => { setDialog(null); toast(message); await load(); onChanged?.() }}
          onError={(message) => toast(message, 'error')}
        />
      )}
    </div>
  )
}

const MODES = {
  in: { title: 'Stock in', subtitle: 'Receipt of goods into inventory', field: 'Quantity received' },
  out: { title: 'Stock out', subtitle: 'Issue or dispatch of goods from inventory', field: 'Quantity issued' },
  adjust: { title: 'Stock adjustment', subtitle: 'Set the counted quantity after a stocktake', field: 'Counted quantity' },
}

function MovementDialog({ mode, onClose, onDone, onError }) {
  const conf = MODES[mode]
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState([])
  const [product, setProduct] = useState(null)
  const [form, setForm] = useState({ quantity: '', reference: '', note: '', unit_cost: '' })
  const [bulk, setBulk] = useState(false)
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState(false)
  const searchRef = useRef(null)

  useEffect(() => {
    let alive = true
    const handle = setTimeout(() => {
      api.products({ search: query, limit: 8, active: '1', sort: 'name' })
        .then((r) => { if (alive) setOptions(r.items) })
        .catch(() => {})
    }, 180)
    return () => { alive = false; clearTimeout(handle) }
  }, [query])

  useEffect(() => { searchRef.current?.focus() }, [])

  const available = product?.quantity ?? 0
  const preview = useMemo(() => {
    const qty = Number(form.quantity) || 0
    if (!product || qty <= 0) return null
    const after = mode === 'in' ? available + qty : mode === 'out' ? available - qty : qty
    return { after, negative: after < 0 }
  }, [product, form.quantity, available, mode])

  async function submit() {
    const qty = Number(form.quantity)
    if (!product) return onError('Select a product first')
    if (!Number.isInteger(qty) || qty <= 0) return onError('Enter a whole quantity greater than zero')
    if (mode === 'out' && qty > available) return onError(`Only ${available} ${product.unit} available`)
    if (mode === 'adjust' && qty === available) return onError('Counted quantity matches current stock')
    setBusy(true)
    try {
      const res = await api.createMovement({
        product_id: product.id,
        type: mode,
        quantity: qty,
        reference: form.reference,
        note: form.note,
        unit_cost: form.unit_cost === '' ? undefined : Number(form.unit_cost),
      })
      onDone(`${product.sku}: new balance ${res.product.quantity} ${product.unit}`)
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function submitBulk() {
    const payload = lines
      .filter((l) => l.product_id && Number(l.quantity) > 0)
      .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }))
    if (!payload.length) return onError('Add at least one line with a quantity')
    setBusy(true)
    try {
      const res = await api.createBulkMovements({ type: mode, lines: payload, reference: form.reference, note: form.note })
      if (res.rejected_count) {
        onDone(`${res.applied_count} line(s) applied, ${res.rejected_count} rejected: ${res.rejected.map((r) => r.reason).join('; ')}`)
      } else {
        onDone(`${res.applied_count} line(s) applied`)
      }
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function addLine(candidate) {
    const existing = lines.find((l) => l.product_id === candidate.id)
    if (existing) { setLines(lines.map((l) => (l.product_id === candidate.id ? { ...l, quantity: Number(l.quantity) + 1 } : l))); return }
    setLines([...lines, { product_id: candidate.id, sku: candidate.sku, name: candidate.name, unit: candidate.unit, available: candidate.quantity, quantity: 1 }])
  }

  return (
    <Modal
      title={conf.title}
      subtitle={conf.subtitle}
      onClose={onClose}
      width={bulk ? 720 : 560}
      footer={(
        <>
          {mode !== 'adjust' && (
            <label className="checkbox">
              <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} />
              <span>Bulk {mode === 'in' ? 'receipt' : 'dispatch'}</span>
            </label>
          )}
          <span className="spacer" />
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={bulk ? submitBulk : submit} disabled={busy}>
            {busy ? 'Saving…' : bulk ? `Apply ${lines.length} line(s)` : `Record stock ${mode}`}
          </Button>
        </>
      )}
    >
      {bulk ? (
        <div className="stack-sm">
          <Field label="Add product">
            <input
              type="search" ref={searchRef} placeholder="Search products to add…"
              value={query} onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <ul className="picker">
            {options.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => addLine(p)} disabled={p.quantity <= 0 && mode === 'out'}>
                  <span><strong>{p.name}</strong> <span className="muted small">{p.sku} · {p.quantity} {p.unit} on hand</span></span>
                  <span aria-hidden="true">+ Add</span>
                </button>
              </li>
            ))}
            {options.length === 0 && <li className="muted small pad">No active products match.</li>}
          </ul>
          <Field label={`Lines (${lines.length})`}>
            {lines.length === 0
              ? <p className="muted small">No lines yet. Search above and add products.</p>
              : (
                <div className="table-scroll">
                  <table className="table table-compact">
                    <thead><tr><th>Product</th><th>Available</th><th className="num">Quantity</th><th /></tr></thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.product_id}>
                          <td><div className="cell-main">{l.name}</div><div className="muted small mono">{l.sku}</div></td>
                          <td className="muted">{l.available} {l.unit}</td>
                          <td className="num">
                            <input
                              type="number" min="1" step="1" className="qty-input" value={l.quantity}
                              onChange={(e) => setLines(lines.map((x) => (x.product_id === l.product_id ? { ...x, quantity: e.target.value } : x)))}
                            />
                          </td>
                          <td><button type="button" className="link-btn" onClick={() => setLines(lines.filter((x) => x.product_id !== l.product_id))}>Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Field>
        </div>
      ) : (
        <div className="stack-sm">
          {product ? (
            <div className="selected-product">
              <div>
                <strong>{product.name}</strong>
                <div className="muted small mono">{product.sku} · {product.category}</div>
              </div>
              <div className="selected-right">
                <span className="muted small">On hand</span>
                <strong>{available} {product.unit}</strong>
                <button type="button" className="link-btn" onClick={() => { setProduct(null); setQuery('') }}>Change</button>
              </div>
            </div>
          ) : (
            <>
              <Field label="Product *">
                <input
                  type="search" ref={searchRef} placeholder="Search by name or SKU…"
                  value={query} onChange={(e) => setQuery(e.target.value)}
                />
              </Field>
              <ul className="picker">
                {options.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => { setProduct(p); setForm((f) => ({ ...f, quantity: mode === 'adjust' ? String(p.quantity) : '' })) }}>
                      <span><strong>{p.name}</strong> <span className="muted small">{p.sku}</span></span>
                      <span className="muted small">{p.quantity} {p.unit}</span>
                    </button>
                  </li>
                ))}
                {options.length === 0 && <li className="muted small pad">No active products match.</li>}
              </ul>
            </>
          )}

          {product && (
            <div className="form-grid">
              <Field label={`${conf.field} *`} hint={preview ? `New balance: ${preview.after} ${product.unit}` : undefined} error={preview?.negative ? 'Exceeds available stock' : undefined}>
                <input type="number" min="1" step="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} autoFocus />
              </Field>
              {mode === 'in' && (
                <Field label="Unit cost" hint={`Default ${money(product.cost_price)}`}>
                  <input type="number" min="0" step="0.01" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} placeholder={String(product.cost_price)} />
                </Field>
              )}
              <Field label="Reference" hint="PO, invoice or order number">
                <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder={mode === 'in' ? 'PO-2026-1042' : 'SO-5183'} />
              </Field>
              <Field label="Note">
                <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={mode === 'out' ? 'Sold to Acme Retail' : 'Received from supplier'} />
              </Field>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
