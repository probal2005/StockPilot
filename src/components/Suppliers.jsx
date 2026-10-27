import { useCallback, useEffect, useState } from 'react'
import { api, dateTime, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Card, Empty, Field, Loading, Modal, Pagination, useToast } from './ui.jsx'
import { useAuth } from '../auth.jsx'

/* Suppliers carry the lead time the replenishment model leans on, so the screen
   puts that number where it cannot be missed. */
export default function Suppliers({ refreshKey, onChanged }) {
  const { can } = useAuth()
  const toast = useToast()
  const [filters, setFilters] = useState({ search: '', active: '1', page: 1, limit: 20 })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // null | {} | supplier
  const [detail, setDetail] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.suppliers(filters))
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { load() }, [load, refreshKey])

  const patch = (next) => setFilters((p) => ({ ...p, ...next, page: next.page ?? 1 }))
  const totalOutstanding = (data?.items ?? []).reduce((n, s) => n + (s.outstanding_value ?? 0), 0)

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Suppliers</h1>
            <p className="muted">Who you buy from, how long they take, and what you owe them.</p>
          </div>
        </div>
        <div className="button-row">
          <a className="btn btn-default btn-sm" href={api.procurementExportUrl({ type: 'suppliers' })}>⤓ Export CSV</a>
          {can('manage') && <Button variant="primary" onClick={() => setEditing({})}>+ New supplier</Button>}
        </div>
      </div>

      <div className="stat-grid stat-grid-3">
        <div className="mini-stat"><span>Suppliers</span><strong>{nf.format(data?.total ?? 0)}</strong></div>
        <div className="mini-stat tone-accent"><span>Open orders</span><strong>{nf.format((data?.items ?? []).reduce((n, s) => n + (s.open_orders ?? 0), 0))}</strong></div>
        <div className="mini-stat tone-warn"><span>Outstanding</span><strong>{money(totalOutstanding)}</strong></div>
      </div>

      <Card padded={false}>
        <div className="toolbar">
          <div className="search">
            <span aria-hidden="true">🔍</span>
            <input
              type="search" placeholder="Search supplier, contact or email…"
              value={filters.search} onChange={(e) => patch({ search: e.target.value })} aria-label="Search suppliers"
            />
          </div>
          <select value={filters.active} onChange={(e) => patch({ active: e.target.value })} aria-label="Filter by state">
            <option value="1">Active suppliers</option>
            <option value="0">Archived</option>
            <option value="all">All</option>
          </select>
        </div>

        {error && <div className="pad"><p className="error-text">{error}</p></div>}
        {loading && !data && <Loading rows={5} label="Loading suppliers" />}
        {data && data.items.length === 0 && (
          <div className="pad"><Empty title="No suppliers yet" hint="Add the vendors you buy from so purchase orders and lead times can resolve to them." /></div>
        )}

        {data && data.items.length > 0 && (
          <>
            <div className="table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Contact</th>
                    <th className="num">Lead time</th>
                    <th className="num">Products</th>
                    <th className="num">Open orders</th>
                    <th className="num">Outstanding</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id} className={s.is_active ? '' : 'row-dim'}>
                      <td>
                        <div className="cell-main">{s.name}</div>
                        {s.notes && <div className="muted small">{s.notes}</div>}
                      </td>
                      <td className="small">
                        {s.contact || '—'}
                        {s.email && <div className="muted mono">{s.email}</div>}
                        {s.phone && <div className="muted mono">{s.phone}</div>}
                      </td>
                      <td className="num"><strong>{nf.format(s.lead_time_days)}</strong> <span className="muted small">days</span></td>
                      <td className="num">{nf.format(s.products ?? 0)}</td>
                      <td className="num">
                        {s.open_orders > 0
                          ? <Badge tone="accent">{nf.format(s.open_orders)}</Badge>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num">{s.outstanding_value > 0 ? money(s.outstanding_value) : <span className="muted">—</span>}</td>
                      <td className="row-actions">
                        <button type="button" className="link-btn" onClick={() => setDetail(s)}>View</button>
                        {can('move') && <button type="button" className="link-btn" onClick={() => setEditing(s)}>Edit</button>}
                        {can('manage') && s.is_active === 1 && (
                          <button
                            type="button" className="link-btn"
                            onClick={async () => {
                              if (!window.confirm(`Archive ${s.name}? Products keep their history and stay linked by name.`)) return
                              try { await api.archiveSupplier(s.id); toast(`${s.name} archived`); await load(); onChanged?.() } catch (e) { toast(e.message, 'error') }
                            }}
                          >
                            Archive
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="muted small">Lead time feeds the replenishment model on the Purchasing screen.</span>
              <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={(page) => setFilters((p) => ({ ...p, page }))} />
            </div>
          </>
        )}
      </Card>

      {editing && (
        <SupplierForm
          initial={editing}
          busy={loading}
          onCancel={() => setEditing(null)}
          onSubmit={async (body) => {
            try {
              if (editing.id) {
                await api.updateSupplier(editing.id, body)
                toast('Supplier updated')
              } else {
                const res = await api.createSupplier(body)
                toast(res.linked_products ? `Supplier added · ${res.linked_products} product(s) linked` : 'Supplier added')
              }
              setEditing(null)
              await load()
              onChanged?.()
            } catch (e) { toast(e.message, 'error') }
          }}
        />
      )}

      {detail && <SupplierDetail supplier={detail} onClose={() => setDetail(null)} onGo={(hash) => { setDetail(null); window.location.hash = hash }} />}
    </div>
  )
}

function SupplierForm({ initial, busy, onCancel, onSubmit }) {
  const isEdit = Boolean(initial.id)
  const [form, setForm] = useState({
    name: initial.name ?? '',
    contact: initial.contact ?? '',
    email: initial.email ?? '',
    phone: initial.phone ?? '',
    lead_time_days: initial.lead_time_days ?? 7,
    notes: initial.notes ?? '',
  })
  const [errors, setErrors] = useState({})
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  function submit(e) {
    e.preventDefault()
    const next = {}
    if (!form.name.trim()) next.name = 'Name is required'
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = 'Enter a valid address'
    const lead = Number(form.lead_time_days)
    if (!Number.isInteger(lead) || lead < 0) next.lead_time_days = 'Whole number of days'
    setErrors(next)
    if (Object.keys(next).length) return
    onSubmit({ ...form, lead_time_days: lead, name: form.name.trim() })
  }

  return (
    <Modal
      title={isEdit ? `Edit ${initial.name}` : 'New supplier'}
      subtitle={isEdit ? 'Renaming a supplier also updates the products already linked to it.' : 'Lead time drives the replenishment model.'}
      onClose={onCancel}
      footer={(
        <>
          <span className="spacer" />
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : isEdit ? 'Save supplier' : 'Add supplier'}</Button>
        </>
      )}
    >
      <form className="form-grid" onSubmit={submit}>
        <Field label="Supplier name *" error={errors.name} wide>
          <input value={form.name} onChange={set('name')} placeholder="Kestrel Peripherals" autoFocus />
        </Field>
        <Field label="Contact person">
          <input value={form.contact} onChange={set('contact')} placeholder="Dana Whitfield" />
        </Field>
        <Field label="Email" error={errors.email}>
          <input type="email" value={form.email} onChange={set('email')} placeholder="orders@vendor.example" />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={set('phone')} placeholder="+1 555 0142" />
        </Field>
        <Field label="Lead time (days)" error={errors.lead_time_days} hint="How long a placed order takes to arrive">
          <input type="number" min="0" step="1" value={form.lead_time_days} onChange={set('lead_time_days')} />
        </Field>
        <Field label="Notes" wide hint="Payment terms, freight thresholds, ordering days…">
          <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="Net 30, free freight above $2,000." />
        </Field>
      </form>
    </Modal>
  )
}

function SupplierDetail({ supplier, onClose, onGo }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    api.supplier(supplier.id).then((r) => { if (alive) setData(r) }).catch(() => {})
    return () => { alive = false }
  }, [supplier.id])

  return (
    <Modal title={supplier.name} subtitle={`${supplier.lead_time_days}-day lead time`} onClose={onClose} width={720}>
      {!data ? <Loading rows={4} label="Loading supplier" /> : (
        <div className="stack-sm">
          {(supplier.contact || supplier.email || supplier.phone) && (
            <div className="detail-hero">
              <div className="detail-hero-copy">
                <div className="detail-hero-title">{supplier.contact || supplier.name}</div>
                <div className="muted small mono">{[supplier.email, supplier.phone].filter(Boolean).join(' · ') || '—'}</div>
                {supplier.notes && <div className="muted small">{supplier.notes}</div>}
              </div>
            </div>
          )}

          <Card title={`Products sourced (${data.products.length})`} padded={false}>
            {data.products.length === 0
              ? <div className="pad"><p className="muted small">No active products are linked to this supplier yet.</p></div>
              : (
                <div className="table-scroll">
                  <table className="table table-compact">
                    <thead><tr><th>SKU</th><th>Product</th><th className="num">On hand</th><th className="num">Reorder at</th><th className="num">Cost</th></tr></thead>
                    <tbody>
                      {data.products.map((p) => (
                        <tr key={p.id}>
                          <td className="mono small">{p.sku}</td>
                          <td className="cell-main">{p.name}</td>
                          <td className="num">{nf.format(p.quantity)} <span className="muted small">{p.unit}</span></td>
                          <td className="num muted">{nf.format(p.reorder_level)}</td>
                          <td className="num">{money(p.cost_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          <Card title={`Purchase order history (${data.orders.length})`} padded={false}>
            {data.orders.length === 0
              ? <div className="pad"><p className="muted small">No purchase orders raised against this supplier.</p></div>
              : (
                <ul className="picker">
                  {data.orders.map((o) => (
                    <li key={o.id}>
                      <button type="button" onClick={() => onGo('#/purchasing')}>
                        <span><strong>{o.reference}</strong> <span className="muted small">{dateTime(o.created_at)}</span></span>
                        <span className={`badge badge-${o.status}`}>{o.status}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>
      )}
    </Modal>
  )
}
