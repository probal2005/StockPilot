import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, dateTime, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Card, Empty, Field, Loading, Modal, Pagination, StatusBadge, useToast } from './ui.jsx'
import { useAuth } from '../auth.jsx'
import { ProductImage } from './ProductImage.jsx'
import { artFor, hasPhoto } from '../product-art.js'
import { readPhotoFile } from '../photo.js'

const BLANK = {
  sku: '', name: '', category: '', description: '', image_url: '', unit: 'pcs',
  cost_price: '', sale_price: '', reorder_level: 10, quantity: 0,
  supplier: '', location: '', is_active: true,
}

const SORTABLE_COLUMNS = [
  ['name', 'Product'],
  ['sku', 'SKU'],
  ['category', 'Category'],
  ['quantity', 'On hand'],
  ['value', 'Stock value'],
  ['updated', 'Updated'],
]

export default function Products({ refreshKey, onChanged }) {
  const { can } = useAuth()
  const toast = useToast()
  const [state, setState] = useState({
    search: '', category: '', status: '', active: '1',
    sort: 'name', dir: 'asc', page: 1, limit: 12,
  })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('table')
  const [error, setError] = useState(null)
  const [categories, setCategories] = useState([])
  const [editing, setEditing] = useState(null)
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.products(state)
      setData(res)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [state])

  useEffect(() => { load() }, [load, refreshKey])
  useEffect(() => { api.categories().then((r) => setCategories(r.items)).catch(() => {}) }, [refreshKey])

  const patch = (next) => setState((prev) => ({ ...prev, ...next, page: next.page ?? 1 }))
  const toggleSort = (column) =>
    patch({ sort: column, dir: state.sort === column && state.dir === 'asc' ? 'desc' : 'asc' })

  const totals = useMemo(() => {
    if (!data?.items) return { value: 0, units: 0 }
    return {
      value: data.items.reduce((s, p) => s + p.stock_value, 0),
      units: data.items.reduce((s, p) => s + p.quantity, 0),
    }
  }, [data])

  async function handleSave(form) {
    setBusy(true)
    try {
      if (editing?.id) {
        const res = await api.updateProduct(editing.id, form)
        toast(res.adjustment
          ? `Updated ${res.product.sku} and logged a stock ${res.adjustment.type} of ${res.adjustment.quantity}`
          : `Updated ${res.product.sku}`)
      } else {
        const res = await api.createProduct(form)
        toast(`Created ${res.product.sku}`)
      }
      setEditing(null)
      await load()
      onChanged?.()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function archive(product) {
    setBusy(true)
    try {
      await api.archiveProduct(product.id)
      toast(`${product.sku} archived — history retained`)
      setDetail(null)
      await load()
      onChanged?.()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function restore(product) {
    setBusy(true)
    try {
      await api.restoreProduct(product.id)
      toast(`${product.sku} restored`)
      setDetail(null)
      await load()
      onChanged?.()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function purge(product) {
    if (!window.confirm(`Permanently delete ${product.sku} and all of its movement history? This cannot be undone.`)) return
    setBusy(true)
    try {
      await api.purgeProduct(product.id)
      toast(`${product.sku} permanently deleted`, 'info')
      setDetail(null)
      await load()
      onChanged?.()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Products</h1>
            <p className="muted">Create, edit and retire catalog items, each with its own artwork. Stock levels change through movements.</p>
          </div>
        </div>
        <div className="head-actions">
          <div className="segmented view-switch">
            {[['table', 'Table'], ['gallery', 'Gallery']].map(([id, label]) => (
              <button key={id} type="button" className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>
            ))}
          </div>
          {can('move') ? (
            <Button variant="primary" onClick={() => setEditing({ ...BLANK })}>+ New product</Button>
          ) : (
            <span className="role-note"><Badge tone="neutral">Viewer</Badge> read-only access</span>
          )}
        </div>
      </div>

      <Card padded={false}>
        <div className="toolbar">
          <div className="search">
            <span aria-hidden="true">🔍</span>
            <input
              type="search"
              placeholder="Search name, SKU, category, supplier, location…"
              value={state.search}
              onChange={(e) => patch({ search: e.target.value })}
              aria-label="Search products"
            />
          </div>
          <select value={state.category} onChange={(e) => patch({ category: e.target.value })} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.products})</option>)}
          </select>
          <select value={state.status} onChange={(e) => patch({ status: e.target.value })} aria-label="Filter by stock status">
            <option value="">All stock levels</option>
            <option value="ok">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
          </select>
          <select value={state.active} onChange={(e) => patch({ active: e.target.value })} aria-label="Filter by record state">
            <option value="1">Active only</option>
            <option value="0">Archived only</option>
            <option value="all">All records</option>
          </select>
          <select value={state.limit} onChange={(e) => patch({ limit: Number(e.target.value) })} aria-label="Rows per page">
            {[12, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
          <div className="toolbar-right">
            <a className="btn btn-default btn-sm" href={api.exportUrl({ type: 'products', search: state.search, category: state.category, status: state.status, active: state.active })}>
              ⤓ Export CSV
            </a>
          </div>
        </div>

        {error && <div className="pad"><p className="error-text">{error}</p></div>}
        {loading && !data && <Loading rows={6} label="Loading products" />}

        {data && data.items.length === 0 && (
          <div className="pad">
            <Empty
              title="No products match these filters"
              hint="Try clearing the search box or switching to all stock levels."
              action={<Button onClick={() => setState({ ...state, search: '', category: '', status: '', active: '1', page: 1 })}>Reset filters</Button>}
            />
          </div>
        )}

        {data && data.items.length > 0 && view === 'gallery' && (
          <div className="product-grid">
            {data.items.map((p) => (
              <article key={p.id} className={`product-card ${p.is_active ? '' : 'row-muted'}`}>
                <button type="button" className="product-card-art" onClick={() => setDetail(p)} aria-label={`Open ${p.name}`}>
                  <ProductImage product={p} size={104} alt={p.name} />
                </button>
                <div className="product-card-body">
                  <span className="product-card-name">{p.name}</span>
                  <span className="mono muted small">{p.sku} · {p.category}</span>
                  <span className="product-card-facts">
                    <strong>{nf.format(p.quantity)}</strong> <span className="muted small">{p.unit} on hand</span>
                  </span>
                  <span className="product-card-facts">
                    <strong>{money(p.stock_value)}</strong> <span className="muted small">at cost</span>
                  </span>
                  <span className="product-card-tags">
                    <StatusBadge status={p.status} />
                    {hasPhoto(p) && <Badge tone="accent">Photo</Badge>}
                    {!hasPhoto(p) && <Badge tone="neutral">{artFor(p).label}</Badge>}
                    {!p.is_active && <Badge tone="neutral">Archived</Badge>}
                  </span>
                </div>
                <div className="product-card-actions">
                  <button type="button" className="link-btn" onClick={() => setDetail(p)}>View</button>
                  {can('move') && <button type="button" className="link-btn" onClick={() => setEditing(p)}>Edit</button>}
                </div>
              </article>
            ))}
          </div>
        )}

        {data && data.items.length > 0 && view === 'table' && (
          <>
            <div className="table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr>
                    {SORTABLE_COLUMNS.map(([key, label]) => (
                      <th key={key}>
                        <button type="button" className={`th-sort ${state.sort === key ? 'active' : ''}`} onClick={() => toggleSort(key)}>
                          {label} {state.sort === key ? (state.dir === 'asc' ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ))}
                    <th className="num">Reorder at</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id} className={p.is_active ? '' : 'row-muted'}>
                      <td>
                        <div className="cell-product">
                          <ProductImage product={p} size={38} />
                          <span className="cell-product-copy">
                            <span className="cell-main">{p.name}</span>
                            <span className="muted small">{p.supplier || '—'}{p.location ? ` · ${p.location}` : ''}</span>
                          </span>
                        </div>
                      </td>
                      <td className="mono">{p.sku}</td>
                      <td>{p.category}</td>
                      <td className="num">
                        <strong>{nf.format(p.quantity)}</strong> <span className="muted small">{p.unit}</span>
                      </td>
                      <td className="num">{money(p.stock_value)}</td>
                      <td className="muted small">{dateTime(p.updated_at)}</td>
                      <td className="num muted">{nf.format(p.reorder_level)}</td>
                      <td>
                        <StatusBadge status={p.status} />
                        {!p.is_active && <span className="badge badge-neutral">Archived</span>}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="link-btn" onClick={() => setDetail(p)}>View</button>
                        {can('move') && <button type="button" className="link-btn" onClick={() => setEditing(p)}>Edit</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="muted small">
                Page totals: {nf.format(totals.units)} units · {money(totals.value)}
              </span>
              <Pagination
                page={data.page} pages={data.pages} total={data.total} limit={data.limit}
                onPage={(page) => setState((prev) => ({ ...prev, page }))}
              />
            </div>
          </>
        )}
      </Card>

      {editing && (
        <ProductForm
          initial={editing}
          categories={categories.map((c) => c.category)}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={handleSave}
        />
      )}

      {detail && (
        <ProductDetail
          product={detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditing(detail); setDetail(null) }}
          onArchive={() => archive(detail)}
          onRestore={() => restore(detail)}
          onPurge={() => purge(detail)}
        />
      )}
    </div>
  )
}

function ProductForm({ initial, categories, busy, onCancel, onSubmit }) {
  const isEdit = Boolean(initial.id)
  const [form, setForm] = useState({
    ...BLANK,
    ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? ''])),
    is_active: initial.is_active !== 0 && initial.is_active !== false,
  })
  const [errors, setErrors] = useState({})
  // The picture is tracked separately from the plain form fields: it can be the
  // artwork, a stored upload, or a pasted link, and each transitions differently.
  const [photo, setPhoto] = useState(() => {
    if (initial.has_photo) return { kind: 'stored', url: initial.image_url, name: 'stored photo' }
    if (initial.image_url) return { kind: 'link', url: initial.image_url }
    return { kind: 'none' }
  })
  const [photoBusy, setPhotoBusy] = useState(false)
  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    if (key === 'image_url') setPhoto(value.trim() ? { kind: 'link', url: value } : { kind: 'none' })
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const margin = (Number(form.sale_price) || 0) - (Number(form.cost_price) || 0)
  const marginPct = Number(form.cost_price) > 0 ? (margin / Number(form.cost_price)) * 100 : null

  function validate() {
    const next = {}
    if (!String(form.sku).trim()) next.sku = 'SKU is required'
    if (!String(form.name).trim()) next.name = 'Name is required'
    for (const key of ['cost_price', 'sale_price']) {
      if (form[key] !== '' && Number(form[key]) < 0) next[key] = 'Must be zero or greater'
    }
    if (form.reorder_level !== '' && Number(form.reorder_level) < 0) next.reorder_level = 'Must be zero or greater'
    if (form.quantity !== '' && (!Number.isInteger(Number(form.quantity)) || Number(form.quantity) < 0)) {
      next.quantity = 'Whole number, zero or greater'
    }
    const url = String(form.image_url ?? '').trim()
    if (url) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') next.image_url = 'Use an http or https URL'
      } catch {
        next.image_url = 'Enter a full URL, e.g. https://example.com/photo.jpg'
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  function submit(e) {
    e.preventDefault()
    if (!validate()) return
    const payload = {
      sku: form.sku,
      name: form.name,
      category: form.category || 'Uncategorized',
      description: form.description || '',
      unit: form.unit || 'pcs',
      image_url: photo.kind === 'link' ? photo.url : '',
      cost_price: Number(form.cost_price) || 0,
      sale_price: Number(form.sale_price) || 0,
      reorder_level: Number(form.reorder_level) || 0,
      supplier: form.supplier || '',
      location: form.location || '',
      is_active: form.is_active,
    }
    if (photo.kind === 'upload') {
      payload.image_data = photo.data
      payload.image_type = photo.type
    } else if (photo.kind === 'stored') {
      // Keep the stored bytes: no image fields are sent at all.
    } else if (initial.has_photo) {
      payload.image_data = '' // the stored photo was removed
      payload.image_type = ''
    }
    if (form.quantity !== '' && Number(form.quantity) !== Number(initial.quantity ?? 0)) {
      payload.quantity = Number(form.quantity)
    } else if (!isEdit) {
      payload.quantity = Number(form.quantity) || 0
    }
    onSubmit(payload)
  }

  return (
    <Modal
      title={isEdit ? `Edit ${initial.sku}` : 'New product'}
      subtitle={isEdit ? 'Changing the quantity logs a stock adjustment in the audit trail.' : 'Opening stock is recorded as a stock-in movement.'}
      onClose={onCancel}
      width={760}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}</Button>
        </>
      )}
    >
      <form className="form-grid" onSubmit={submit}>
        <Field label="SKU *" error={errors.sku}>
          <input value={form.sku} onChange={set('sku')} placeholder="ELC-1009" autoFocus />
        </Field>
        <Field label="Product name *" error={errors.name}>
          <input value={form.name} onChange={set('name')} placeholder="Wireless Charging Pad" />
        </Field>
        <Field label="Category">
          <input value={form.category} onChange={set('category')} list="category-options" placeholder="Electronics" />
          <datalist id="category-options">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>
        <Field label="Product image" error={errors.image_url} hint="Upload a photo, or paste an https URL. Leave empty to use the generated artwork." wide>
          <span className="image-field" data-photo={photo.kind}>
            <ProductImage product={{ ...form, name: form.name, image_url: photo.kind === 'stored' || photo.kind === 'upload' ? photo.url : '' }} size={64} alt="Preview" />
            <span className="image-controls">
              <input
                type="url" value={photo.kind === 'link' ? photo.url : form.image_url} onChange={set('image_url')}
                placeholder="https://example.com/photo.jpg" aria-label="Product image URL"
              />
              <span className="image-actions">
                <label className="btn btn-sm btn-default image-upload">
                  {photoBusy ? 'Reading…' : photo.kind === 'upload' ? 'Replace photo' : 'Upload photo'}
                  <input
                    type="file" className="image-file" accept="image/png,image/jpeg,image/webp"
                    disabled={photoBusy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      setPhotoBusy(true)
                      try {
                        const picked = await readPhotoFile(file)
                        // `url` is what the preview renders; `data`/`type` are what the API stores.
                        setPhoto({ kind: 'upload', ...picked, url: picked.data })
                        setForm((prev) => ({ ...prev, image_url: '' }))
                        setErrors((prev) => ({ ...prev, image_url: undefined }))
                      } catch (err) {
                        setErrors((prev) => ({ ...prev, image_url: err.message }))
                      } finally {
                        setPhotoBusy(false)
                      }
                    }}
                  />
                </label>
                {photo.kind === 'none' ? null : (
                  <Button size="sm" onClick={() => { setPhoto({ kind: 'none' }); setForm((prev) => ({ ...prev, image_url: '' })) }}>
                    Remove photo
                  </Button>
                )}
              </span>
            </span>
          </span>
        </Field>
        <Field label="Unit">
          <input value={form.unit} onChange={set('unit')} placeholder="pcs" list="unit-options" />
          <datalist id="unit-options">
            {['pcs', 'box', 'pack', 'set', 'ream', 'kit', 'kg', 'litre'].map((u) => <option key={u} value={u} />)}
          </datalist>
        </Field>
        <Field label="Cost price" error={errors.cost_price} hint="What you pay your supplier">
          <input type="number" min="0" step="0.01" value={form.cost_price} onChange={set('cost_price')} />
        </Field>
        <Field label="Sale price" error={errors.sale_price} hint={marginPct === null ? undefined : `Margin ${money(margin)} (${marginPct.toFixed(1)}%)`}>
          <input type="number" min="0" step="0.01" value={form.sale_price} onChange={set('sale_price')} />
        </Field>
        <Field label="Reorder level" error={errors.reorder_level} hint="Alerts trigger at or below this level">
          <input type="number" min="0" step="1" value={form.reorder_level} onChange={set('reorder_level')} />
        </Field>
        <Field label={isEdit ? 'Quantity on hand' : 'Opening quantity'} error={errors.quantity} hint={isEdit ? 'Logged as an adjustment' : 'Logged as stock-in'}>
          <input type="number" min="0" step="1" value={form.quantity} onChange={set('quantity')} />
        </Field>
        <Field label="Supplier">
          <input value={form.supplier} onChange={set('supplier')} placeholder="Northwind Tech" />
        </Field>
        <Field label="Storage location">
          <input value={form.location} onChange={set('location')} placeholder="Aisle B-2" />
        </Field>
        <Field label="Description" wide>
          <textarea rows="2" value={form.description} onChange={set('description')} placeholder="Optional notes shown on the product record" />
        </Field>
        {isEdit && (
          <label className="checkbox field-wide">
            <input type="checkbox" checked={form.is_active} onChange={set('is_active')} />
            <span>Active — archived products cannot receive stock movements</span>
          </label>
        )}
      </form>
    </Modal>
  )
}

function ProductDetail({ product, busy, onClose, onEdit, onArchive, onRestore, onPurge }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api.product(product.id)
      .then((d) => { if (alive) setDetail(d) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [product.id])

  const p = detail?.product ?? product

  return (
    <Modal
      title={p.name}
      subtitle={`${p.sku} · ${p.category}`}
      onClose={onClose}
      width={820}
      footer={(
        <>
          {p.is_active
            ? <Button variant="danger" onClick={onArchive} disabled={busy}>Archive</Button>
            : <Button variant="primary" onClick={onRestore} disabled={busy}>Restore</Button>}
          <Button variant="danger-ghost" onClick={onPurge} disabled={busy}>Delete permanently</Button>
          <span className="spacer" />
          <Button onClick={onEdit}>Edit</Button>
        </>
      )}
    >
      <div className="detail-hero">
        <ProductImage product={p} size={132} alt={p.name} />
        <div className="detail-hero-copy">
          <span className="detail-hero-title">{p.name}</span>
          <span className="mono muted">{p.sku} · {p.category}</span>
          <span className="detail-hero-tags">
            <StatusBadge status={p.status} />
            {hasPhoto(p)
              ? <a className="link-btn" href={p.image_url} target="_blank" rel="noreferrer">Open photo</a>
              : <Badge tone="neutral">Generated artwork</Badge>}
          </span>
          {!hasPhoto(p) && <span className="muted small">{artFor(p).label} palette · {(artFor(p).monogram)}</span>}
        </div>
      </div>

      <div className="detail-grid">
        <div><span className="muted small">On hand</span><strong>{nf.format(p.quantity)} {p.unit}</strong></div>
        <div><span className="muted small">Reorder level</span><strong>{nf.format(p.reorder_level)}</strong></div>
        <div><span className="muted small">Status</span><StatusBadge status={p.status} /></div>
        <div><span className="muted small">Cost / Sale</span><strong>{money(p.cost_price)} / {money(p.sale_price)}</strong></div>
        <div><span className="muted small">Stock value</span><strong>{money(p.stock_value)}</strong></div>
        <div><span className="muted small">Retail value</span><strong>{money(p.retail_value)}</strong></div>
        <div><span className="muted small">Supplier</span><strong>{p.supplier || '—'}</strong></div>
        <div><span className="muted small">Location</span><strong>{p.location || '—'}</strong></div>
      </div>
      {p.description && <p className="detail-note">{p.description}</p>}

      <h4 className="sub-head">Movement history</h4>
      {error && <p className="error-text">{error}</p>}
      {!detail && !error && <Loading rows={3} label="Loading history" />}
      {detail && detail.movements.length === 0 && <Empty title="No movements recorded yet" />}
      {detail && detail.movements.length > 0 && (
        <div className="table-scroll">
          <table className="table table-compact">
            <thead>
              <tr><th>When</th><th>Type</th><th className="num">Qty</th><th className="num">Balance</th><th>Reference</th></tr>
            </thead>
            <tbody>
              {detail.movements.map((m) => (
                <tr key={m.id}>
                  <td className="muted small">{dateTime(m.created_at)}</td>
                  <td><span className={`chip chip-${m.type}`}>{m.type === 'in' ? 'In' : 'Out'}</span></td>
                  <td className="num">{nf.format(m.quantity)}</td>
                  <td className="num">{nf.format(m.balance_after)}</td>
                  <td className="small">{m.reference || '—'}<div className="muted">{m.note}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
