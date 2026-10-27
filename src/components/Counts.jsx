import { useCallback, useEffect, useState } from 'react'
import { api, dateTime, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'
import { Badge, Button, Card, Empty, Field, Loading, Modal, Pagination, useToast } from './ui.jsx'
import { useAuth } from '../auth.jsx'

export default function Counts({ refreshKey, onChanged }) {
  const { can } = useAuth()
  const toast = useToast()
  const [filters, setFilters] = useState({ page: 1, limit: 20 })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(null) // count id

  const load = useCallback(async () => {
    try { setData(await api.counts(filters)); setError(null) } catch (e) { setError(e.message) }
  }, [filters])

  useEffect(() => { load() }, [load, refreshKey])
  const patch = (next) => setFilters((p) => ({ ...p, ...next, page: next.page ?? 1 }))

  return (
    <div className="stack">
      <div className="page-head">
        <div className="head-text">
          <LogoMark size={36} className="head-mark" />
          <div className="head-copy">
            <h1>Stock counts</h1>
            <p className="muted">Count what is physically there, compare it to the system, post the difference once.</p>
          </div>
        </div>
        <div className="button-row">
          <a className="btn btn-default btn-sm" href={api.countExportUrl({})}>⤓ Export CSV</a>
          {can('move') && <Button variant="primary" onClick={() => setCreating(true)}>+ New count</Button>}
        </div>
      </div>

      <div className="stat-grid stat-grid-3">
        <div className="mini-stat"><span>Counts</span><strong>{nf.format(data?.total ?? 0)}</strong></div>
        <div className="mini-stat tone-accent"><span>Open</span><strong>{nf.format(data?.open_counts ?? 0)}</strong></div>
        <div className="mini-stat tone-warn"><span>Still to count</span><strong>{nf.format((data?.items ?? []).reduce((n, c) => n + (c.unchecked ?? 0), 0))}</strong></div>
      </div>

      {error && <div className="pad"><p className="error-text">{error}</p></div>}

      <Card padded={false} title="Count sessions" subtitle="Nothing changes in stock until a count is posted">
        {!data && <Loading rows={4} label="Loading counts" />}
        {data && data.items.length === 0 && (
          <div className="pad"><Empty title="No counts yet" hint="Start one for a category, or count the whole catalogue." /></div>
        )}
        {data && data.items.length > 0 && (
          <>
            <div className="table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr><th>Reference</th><th>Scope</th><th>Status</th>
                    <th className="num">Progress</th><th className="num">Variances</th>
                    <th>Created</th><th>Posted</th><th aria-label="Actions" /></tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id}>
                      <td className="mono small"><strong>{c.reference}</strong>{c.notes && <div className="muted small">{c.notes}</div>}</td>
                      <td className="small">{c.scope_label}</td>
                      <td><span className={`badge badge-${c.status === 'posted' ? 'ok' : c.status === 'cancelled' ? 'out' : 'accent'}`}>{c.status}</span></td>
                      <td className="num">
                        <span className="progress" aria-label={`${c.completion}% counted`}>
                          <span className="progress-fill" style={{ width: `${c.completion}%` }} data-tone={c.completion === 100 ? 'ok' : 'accent'} />
                        </span>
                        <span className="muted small"> {c.checked}/{c.lines}</span>
                      </td>
                      <td className="num">
                        {c.variances > 0
                          ? <span className="neg"><strong>{c.variances}</strong> <span className="muted small">· {money(c.variance_value)}</span></span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="small muted">{dateTime(c.created_at)}</td>
                      <td className="small muted">{c.posted_at ? dateTime(c.posted_at) : '—'}</td>
                      <td className="row-actions">
                        <button type="button" className="link-btn" onClick={() => setOpen(c.id)}>
                          {c.status === 'open' ? 'Count' : 'View'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="muted small">A posted count writes one adjustment per discrepant line, all under its reference.</span>
              <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={(page) => setFilters((p) => ({ ...p, page }))} />
            </div>
          </>
        )}
      </Card>

      {creating && (
        <CountForm
          onCancel={() => setCreating(false)}
          onDone={async (message) => { setCreating(false); toast(message); await load(); onChanged?.() }}
          onError={(m) => toast(m, 'error')}
        />
      )}

      {open && (
        <CountSheet
          countId={open}
          canPost={can('move')}
          onClose={() => setOpen(null)}
          onChanged={async (message) => { if (message) toast(message); await load(); onChanged?.() }}
          onError={(m) => toast(m, 'error')}
        />
      )}
    </div>
  )
}

function CountForm({ onCancel, onDone, onError }) {
  const [scope, setScope] = useState('all')
  const [categories, setCategories] = useState([])
  const [category, setCategory] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.categories().then((r) => setCategories(r.items)).catch(() => {}) }, [])

  async function submit() {
    setBusy(true)
    try {
      const res = await api.createCount({
        scope: scope === 'category' && category ? `category:${category}` : 'all',
        notes,
      })
      onDone(`${res.count.reference} opened · ${res.count.lines} product(s) on the sheet`)
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New stock count"
      subtitle="The sheet snapshots today's system quantities, so later movements do not rewrite the variance."
      onClose={onCancel}
      footer={(
        <>
          <span className="spacer" />
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Starting…' : 'Start count'}</Button>
        </>
      )}
    >
      <div className="stack-sm">
        <Field label="Count what">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">Whole catalogue</option>
            <option value="category">One category</option>
          </select>
        </Field>
        {scope === 'category' && (
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose a category…</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Quarterly count of the storage aisle" />
        </Field>
      </div>
    </Modal>
  )
}

/* ----------------------------------------------------------- the sheet ---- */

function CountSheet({ countId, canPost, onClose, onChanged, onError }) {
  const [data, setData] = useState(null)
  const [entries, setEntries] = useState({})
  const [busy, setBusy] = useState(false)
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    const res = await api.count(countId)
    setData(res)
    setEntries(Object.fromEntries(res.lines.map((l) => [l.product_id, l.counted_qty === null ? '' : String(l.counted_qty)])))
  }, [countId])

  useEffect(() => { load().catch((e) => onError(e.message)) }, [load, onError])

  if (!data) return <Modal title="Stock count" onClose={onClose}><Loading rows={5} label="Loading sheet" /></Modal>

  const c = data.count
  const isOpen = c.status === 'open'
  const rows = data.lines
  const countedNow = rows.filter((r) => entries[r.product_id] !== '' && entries[r.product_id] !== undefined).length
  const varianceRows = rows.filter((r) => {
    const v = entries[r.product_id]
    return v !== '' && v !== undefined && Number(v) !== r.system_qty
  })
  const netUnits = varianceRows.reduce((n, r) => n + (Number(entries[r.product_id]) - r.system_qty), 0)
  const grossValue = varianceRows.reduce((n, r) => n + Math.abs(Number(entries[r.product_id]) - r.system_qty) * r.cost_price, 0)

  async function save() {
    setBusy(true)
    try {
      await api.updateCount(countId, {
        lines: rows.map((r) => ({
          product_id: r.product_id,
          counted_qty: entries[r.product_id] === '' ? null : Number(entries[r.product_id]),
        })),
      })
      onChanged('Counted quantities saved')
      await load()
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function post() {
    setBusy(true)
    try {
      await api.updateCount(countId, {
        lines: rows.map((r) => ({ product_id: r.product_id, counted_qty: entries[r.product_id] === '' ? null : Number(entries[r.product_id]) })),
      })
      const res = await api.postCount(countId, { require_complete: countedNow === rows.length })
      onChanged(`${res.posted} adjustment(s) posted · net ${res.net_units >= 0 ? '+' : ''}${res.net_units} units`)
      await load()
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Count ${c.reference}`}
      subtitle={`${c.scope_label} · started ${dateTime(c.created_at)}`}
      onClose={onClose}
      width={900}
      footer={(
        <>
          <span className="muted small">
            {countedNow}/{rows.length} counted ·
            {' '}{varianceRows.length} variance(s) · net {netUnits >= 0 ? '+' : ''}{netUnits} units · {money(grossValue)}
          </span>
          <span className="spacer" />
          <Button onClick={onClose}>Close</Button>
          {isOpen && canPost && <Button onClick={save} disabled={busy}>Save progress</Button>}
          {isOpen && canPost && (
            <Button variant="primary" onClick={post} disabled={busy || varianceRows.length === 0}>
              {busy ? 'Working…' : `Post ${varianceRows.length} adjustment(s)`}
            </Button>
          )}
        </>
      )}
    >
      <div className="table-scroll count-sheet">
        <table className="table table-compact">
          <thead>
            <tr><th>Product</th><th className="num">System</th><th className="num">Counted</th><th className="num">Variance</th><th>Location</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const raw = entries[r.product_id]
              const has = raw !== '' && raw !== undefined
              const variance = has ? Number(raw) - r.system_qty : null
              return (
                <tr key={r.product_id} data-variance={variance === 0 ? 'match' : variance === null ? 'todo' : 'diff'}>
                  <td><div className="cell-main">{r.name}</div><div className="muted small mono">{r.sku} · {r.unit}</div></td>
                  <td className="num">{nf.format(r.system_qty)}</td>
                  <td className="num">
                    {isOpen ? (
                      <input
                        type="number" min="0" step="1" className="qty-input" value={raw}
                        placeholder="—" disabled={busy}
                        onChange={(e) => setEntries((prev) => ({ ...prev, [r.product_id]: e.target.value }))}
                        aria-label={`Counted quantity for ${r.name}`}
                      />
                    ) : (
                      <strong>{r.counted_qty === null ? '—' : nf.format(r.counted_qty)}</strong>
                    )}
                  </td>
                  <td className="num">
                    {variance === null
                      ? <span className="muted">not counted</span>
                      : variance === 0
                        ? <span className="pos">✓ match</span>
                        : <span className={variance > 0 ? 'pos' : 'neg'}><strong>{variance > 0 ? '+' : ''}{variance}</strong>
                            <span className="muted small"> {money(Math.abs(variance) * r.cost_price)}</span>
                          </span>}
                  </td>
                  <td className="small muted">{r.location || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
