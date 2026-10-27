// Shared UI primitives: glass cards, animated counters, toasts and the chart
// set. Every chart animates itself in on mount / data change and honours
// `prefers-reduced-motion`.
import { Fragment, createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { compact, dayLabel, money, nf } from '../api.js'
import { LogoMark } from '../brand.jsx'

/* ------------------------------------------------------------------ motion */

const QUERY = '(prefers-reduced-motion: reduce)'

// Fall back to setTimeout where rAF is unavailable (SSR, bare test runners) so
// the animation hooks never throw outside a browser.
const raf = (cb) => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(cb)
  : setTimeout(() => cb(performance.now()), 16))
const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(QUERY)?.matches),
  )
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY)
    if (!mq) return undefined
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Flips false -> true one paint after `signature` changes, so CSS transitions
 * replay from their start state on every data refresh.
 */
export function useGrowIn(signature) {
  const reduced = useReducedMotion()
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    if (reduced) { setGrown(true); return undefined }
    setGrown(false)
    let inner = 0
    const outer = raf(() => { inner = raf(() => setGrown(true)) })
    return () => { caf(outer); caf(inner) }
  }, [signature, reduced])
  return grown
}

/** Eased 0..1 progress driven by rAF, restarted whenever `signature` changes. */
export function useProgress(signature, duration = 850) {
  const reduced = useReducedMotion()
  const [progress, setProgress] = useState(reduced ? 1 : 0)
  useEffect(() => {
    if (reduced) { setProgress(1); return undefined }
    let handle = 0
    const start = performance.now()
    setProgress(0)
    const tick = (now) => {
      const k = Math.min(1, (now - start) / duration)
      setProgress(1 - (1 - k) ** 3)
      if (k < 1) handle = raf(tick)
    }
    handle = raf(tick)
    return () => caf(handle)
  }, [signature, duration, reduced])
  return progress
}

/** Counts a number up from zero with an ease-out curve. */
export function AnimatedNumber({ value, format = (v) => nf.format(Math.round(v)), duration = 900, className = '' }) {
  const reduced = useReducedMotion()
  const target = Number(value) || 0
  const [shown, setShown] = useState(reduced ? target : 0)
  useEffect(() => {
    if (reduced) { setShown(target); return undefined }
    let handle = 0
    const start = performance.now()
    const from = 0
    const tick = (now) => {
      const k = Math.min(1, (now - start) / duration)
      setShown(from + (target - from) * (1 - (1 - k) ** 3))
      if (k < 1) handle = raf(tick)
    }
    handle = raf(tick)
    return () => caf(handle)
  }, [target, duration, reduced])
  return <span className={className}>{format(shown)}</span>
}

/* ------------------------------------------------------------------ layout */

export function Card({ title, subtitle, actions, children, padded = true, className = '', delay = 0, hero = false }) {
  const ref = useRef(null)
  // Spotlight: the pointer position is written to CSS variables directly so
  // hovering never triggers a React re-render.
  const onPointerMove = (event) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${event.clientX - rect.left}px`)
    el.style.setProperty('--my', `${event.clientY - rect.top}px`)
  }
  return (
    <section
      ref={ref}
      className={`card ${hero ? 'card-hero' : ''} ${className}`}
      style={{ '--i': delay }}
      onPointerMove={onPointerMove}
    >
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'card-body' : ''}>{children}</div>
    </section>
  )
}

/**
 * Reveals its children the first time they scroll into view. Falls back to
 * visible immediately wherever IntersectionObserver is missing (SSR, jsdom),
 * so content is never hidden without JS.
 */
export function Reveal({ children, className = '', delay = 0, as: Tag = 'div' }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    if (typeof IntersectionObserver === 'undefined') { el.classList.add('is-visible'); return undefined }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target) }
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return <Tag ref={ref} className={`reveal ${className}`.trim()} style={{ '--i': delay }}>{children}</Tag>
}

export function Sparkline({ data, tone = 'accent', height = 46 }) {
  const series = (data ?? []).map((d) => Number(typeof d === 'object' ? d.value : d) || 0)
  const grown = useGrowIn(series.join(','))
  const gid = useId().replace(/:/g, '')
  if (series.length < 2) return null
  const W = 200
  const H = height
  const min = Math.min(...series, 0)
  const max = Math.max(...series, 1)
  const span = max - min || 1
  const pt = (v, i) => [
    (i / (series.length - 1)) * W,
    H - 4 - ((v - min) / span) * (H - 10),
  ]
  const points = series.map(pt)
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  return (
    <svg className={`spark spark-${tone}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`spark-fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="spark-stop-strong" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="100%" className="spark-stop-fade" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-fill-${gid})`} className="spark-area" style={{ opacity: grown ? 1 : 0 }} />
      <path
        d={line} fill="none" pathLength="1" className="spark-line"
        style={{ strokeDasharray: 1, strokeDashoffset: grown ? 0 : 1 }}
      />
    </svg>
  )
}

export function StatCard({ label, value, format, hint, tone = 'default', icon, trend, spark, bar, barTone, delay = 0 }) {
  return (
    <article className={`stat stat-${tone}`} style={{ '--i': delay }}>
      {spark && spark.length > 1 && (
        <div className="stat-spark"><Sparkline data={spark} tone={tone} /></div>
      )}
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon" aria-hidden="true">{icon}</span>}
      </div>
      <strong className="stat-value">
        {typeof value === 'number' ? <AnimatedNumber value={value} format={format} /> : value}
      </strong>
      {typeof bar === 'number' && (
        <div className={`stat-bar stat-bar-${barTone ?? tone}`}>
          <span style={{ width: `${Math.max(2, Math.min(100, bar * 100))}%` }} />
        </div>
      )}
      <div className="stat-foot">
        {hint && <span>{hint}</span>}
        {trend && (
          <span className={`trend trend-${trend.dir}`}>
            <i aria-hidden="true">{trend.dir === 'up' ? '▲' : '▼'}</i> {trend.text}
          </span>
        )}
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ atoms */

const STATUS_LABEL = { ok: 'In stock', low: 'Low stock', out: 'Out of stock' }
const statusLabel = (s) => STATUS_LABEL[s] ?? s

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{statusLabel(status)}</span>
}

export function Badge({ children, tone = 'neutral' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Button({ variant = 'default', size = 'md', children, ...rest }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size}`} {...rest}>
      {children}
    </button>
  )
}

export function Field({ label, hint, error, children, wide = false }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''} ${error ? 'field-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <small className="field-hint">{hint}</small>}
      {error && <small className="field-msg">{error}</small>}
    </label>
  )
}

export function Modal({ title, subtitle, onClose, children, footer, width = 620 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div className="modal-title">
            <LogoMark size={30} className="modal-mark" />
            <div>
              <h3>{title}</h3>
              {subtitle && <p className="card-sub">{subtitle}</p>}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2)
    setItems((prev) => [...prev, { id, message, tone }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4400)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span className="toast-icon" aria-hidden="true">{t.tone === 'error' ? '⚠' : t.tone === 'info' ? 'ℹ' : '✓'}</span>
            <span>{t.message}</span>
            <i className="toast-timer" aria-hidden="true" />
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function Empty({ title, hint, action }) {
  return (
    <div className="empty">
      <LogoMark size={54} className="empty-mark" />
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  )
}

export function Loading({ label = 'Loading…', rows = 5 }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label={label}>
      <div className="skeleton-head">
        <LogoMark size={26} className="skeleton-mark" />
        <span>{label}</span>
      </div>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row" style={{ '--i': i }} />)}
    </div>
  )
}

export function Pagination({ page, pages, total, limit, onPage }) {
  if (pages <= 1) {
    return <div className="pager"><span className="muted">{nf.format(total)} record{total === 1 ? '' : 's'}</span></div>
  }
  return (
    <div className="pager">
      <span className="muted">
        {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {nf.format(total)}
      </span>
      <div className="pager-buttons">
        <Button size="sm" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>← Prev</Button>
        <span className="pager-page">Page {page} / {pages}</span>
        <Button size="sm" onClick={() => onPage(Math.min(pages, page + 1))} disabled={page >= pages}>Next →</Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ charts */

const CHART_COLORS = [
  'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)',
]

export function ChartToggle({ value, onChange, options = [['bars', 'Bars'], ['area', 'Area'], ['line', 'Line']] }) {
  return (
    <div className="segmented">
      {options.map(([id, label]) => (
        <button key={id} type="button" className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  )
}

const DEFAULT_BARS = [['units_in', 'Stock in'], ['units_out', 'Stock out']]

function niceMax(v) {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / mag) * mag
}

function ChartTooltip({ left, date, rows, foot }) {
  return (
    <div className="chart-tip" style={{ left: `${left}%` }}>
      <strong>{dayLabel(date)}</strong>
      {rows.map(([label, value, color]) => (
        <span key={label}><i className="swatch" style={{ background: color }} />{label}: {nf.format(value)}</span>
      ))}
      {foot !== undefined && foot !== null && <span className="muted">Out value: {money(foot)}</span>}
    </div>
  )
}

/** Grouped bars that grow up from the baseline, staggered left to right. */
function BarsLayer({ data, bars, plot, grown }) {
  const { padL, padT, plotH, bandWidth } = plot
  const max = niceMax(Math.max(1, ...data.flatMap((d) => bars.map(([k]) => Number(d[k]) || 0))))
  const groupW = bandWidth * 0.66
  const barW = groupW / bars.length
  const groups = []
  for (let i = 0; i < data.length; i += 1) {
    const x = padL + i * bandWidth
    for (let bi = 0; bi < bars.length; bi += 1) {
      const [key, , color] = bars[bi]
      const value = Number(data[i][key]) || 0
      const h = (value / max) * plotH
      groups.push(
        <rect
          key={`${key}-${data[i].date ?? i}`}
          className={`bar bar-${key}`}
          x={x + bandWidth / 2 - groupW / 2 + bi * barW + 1}
          y={padT + plotH - h}
          width={Math.max(1, barW - 2)}
          height={Math.max(value > 0 ? 2 : 0, h)}
          rx="3"
          fill={color}
          style={{
            transformOrigin: `${x + bandWidth / 2}px ${padT + plotH}px`,
            transform: grown ? 'scaleY(1)' : 'scaleY(0)',
            transition: `transform 700ms cubic-bezier(.22,1,.36,1) ${i * 26}ms`,
          }}
        />,
      )
    }
  }
  return <g>{groups}</g>
}

/** Smooth area + line layer that draws itself in. */
function SeriesLayer({ data, bars, plot, grown, variant }) {
  const { padL, padT, plotH, bandWidth } = plot
  const max = niceMax(Math.max(1, ...data.flatMap((d) => bars.map(([k]) => Number(d[k]) || 0))))
  const gid = useId().replace(/:/g, '')
  const xAt = (i) => padL + i * bandWidth + bandWidth / 2
  const yAt = (v) => padT + plotH - (Number(v) || 0) / max * plotH
  const curve = (key) => {
    const pts = data.map((d, i) => [xAt(i), yAt(d[key])])
    if (pts.length < 2) return ''
    let path = `M${pts[0][0]},${pts[0][1]}`
    for (let i = 1; i < pts.length; i += 1) {
      const [px, py] = pts[i - 1]
      const [cx, cy] = pts[i]
      const mx = (px + cx) / 2
      path += ` C${mx},${py} ${mx},${cy} ${cx},${cy}`
    }
    return path
  }
  return (
    <g>
      <defs>
        {bars.map(([key, , color], bi) => (
          <linearGradient key={key} id={`area-${gid}-${bi}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={variant === 'area' ? 0.42 : 0.14} />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {bars.map(([key, , color], bi) => {
        const d = curve(key)
        if (!d) return null
        return <path key={`a-${key}`} d={`${d} L${xAt(data.length - 1)},${padT + plotH} L${xAt(0)},${padT + plotH} Z`}
          fill={`url(#area-${gid}-${bi})`}
          style={{ opacity: grown ? 1 : 0, transition: `opacity 900ms ease ${bi * 120}ms` }} />
      })}
      {bars.map(([key, , color], bi) => (
        <path
          key={`l-${key}`} d={curve(key)} fill="none" stroke={color} strokeWidth="2.5"
          strokeLinecap="round" pathLength="1"
          style={{
            strokeDasharray: 1,
            strokeDashoffset: grown ? 0 : 1,
            transition: `stroke-dashoffset 1300ms cubic-bezier(.4,0,.2,1) ${bi * 140}ms`,
          }}
        />
      ))}
      {data.map((d, i) => bars.map(([key, , color], bi) => (
        <circle
          key={`p-${key}-${i}`} cx={xAt(i)} cy={yAt(d[key])} r="3" fill={color}
          className="chart-node"
          style={{ opacity: grown ? 1 : 0, transition: `opacity 400ms ease ${600 + bi * 120 + i * 30}ms` }}
        />
      )))}
    </g>
  )
}

export function BarChart({ data, height = 220, bars = DEFAULT_BARS, type = 'bars' }) {
  const [hover, setHover] = useState(null)
  const grown = useGrowIn(`${type}|${data.length}|${data[0]?.date ?? ''}|${data[data.length - 1]?.date ?? ''}`)
  const series = bars.map(([key, label], bi) => [key, label, CHART_COLORS[bi]])
  const points = data ?? []

  if (!points.length) {
    return <Empty title="No activity in this period" hint="Record a stock movement to populate the chart." />
  }

  const padL = 46
  const padB = 30
  const padT = 14
  const bandWidth = Math.max(20, Math.min(70, 660 / points.length))
  const width = padL + bandWidth * points.length + 14
  const plotH = height - padB - padT
  const plot = { padL, padT, plotH, bandWidth, width }
  const max = niceMax(Math.max(1, ...points.flatMap((d) => series.map(([k]) => Number(d[k]) || 0))))
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const labelEvery = Math.ceil(points.length / 10)
  const hoverIndex = hover?.index ?? null

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} className={`chart chart-${type}`} preserveAspectRatio="none" style={{ minWidth: width }}>
        {ticks.map((t) => {
          const y = padT + plotH - plotH * t
          return (
            <g key={t}>
              <line x1={padL} x2={width} y1={y} y2={y} className="grid" />
              <text x={padL - 9} y={y + 4} className="axis" textAnchor="end">{compact(max * t)}</text>
            </g>
          )
        })}
        {hoverIndex !== null && (
          <rect
            x={padL + hoverIndex * bandWidth} y={padT} width={bandWidth} height={plotH}
            className="chart-highlight" rx="6"
          />
        )}
        {type === 'bars'
          ? <BarsLayer data={points} bars={series} plot={plot} grown={grown} />
          : <SeriesLayer data={points} bars={series} plot={plot} grown={grown} variant={type} />}
        {points.map((d, i) => (
          <g key={`hit-${d.date ?? i}`} onMouseEnter={() => setHover({ index: i })}>
            <rect x={padL + i * bandWidth} y={padT} width={bandWidth} height={plotH} fill="transparent" />
            {(i % labelEvery === 0 || points.length <= 10) && (
              <text x={padL + i * bandWidth + bandWidth / 2} y={height - 9} className="axis" textAnchor="middle">{dayLabel(d.date)}</text>
            )}
          </g>
        ))}
      </svg>
      <div className="legend">
        {series.map(([key, label, color]) => (
          <span key={key} className="legend-item"><i className="swatch" style={{ background: color }} />{label}</span>
        ))}
      </div>
      {hoverIndex !== null && (
        <ChartTooltip
          left={((padL + hoverIndex * bandWidth + bandWidth / 2) / width) * 100}
          date={points[hoverIndex].date}
          rows={series.map(([key, label, color]) => [label, Number(points[hoverIndex][key]) || 0, color])}
          foot={points[hoverIndex].value_out}
        />
      )}
    </div>
  )
}

/** Animated donut with a centre total and an interactive legend. */
export function DonutChart({ items, total, formatter = money, centerLabel = 'Total value' }) {
  const [active, setActive] = useState(null)
  const sig = items.map((i) => `${i.label}:${i.value}`).join('|')
  const progress = useProgress(sig, 1000)
  const sum = total ?? items.reduce((s, i) => s + (Number(i.value) || 0), 0)
  const R = 54
  const C = 2 * Math.PI * R
  let offset = 0

  if (!items.length || sum <= 0) return <Empty title="No stock value to chart" />

  return (
    <div className="donut-wrap">
      <div className="donut">
        <svg viewBox="0 0 140 140" className="donut-svg" role="img" aria-label={`${centerLabel}: ${formatter(sum)}`}>
          <circle cx="70" cy="70" r={R} className="donut-track" />
          {items.map((item, i) => {
            const share = (Number(item.value) || 0) / sum
            const len = share * C * progress
            const dash = `${len} ${C - len}`
            const rotation = -90 + (offset / C) * 360
            offset += share * C
            const isActive = active === null || active === i
            return (
              <circle
                key={item.label}
                className={`donut-seg ${active === i ? 'donut-seg-active' : ''}`}
                cx="70" cy="70" r={R}
                fill="none"
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth={active === i ? 19 : 15}
                strokeDasharray={dash}
                strokeLinecap="butt"
                style={{ transform: `rotate(${rotation}deg)`, transformOrigin: '70px 70px', opacity: isActive ? 1 : 0.32, transition: 'opacity 220ms ease, stroke-width 220ms ease' }}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
              />
            )
          })}
        </svg>
        <div className="donut-center">
          <span className="muted small">{active === null ? centerLabel : items[active].label}</span>
          <strong>{formatter(active === null ? sum : Number(items[active].value) || 0)}</strong>
          {active !== null && (
            <span className="muted small">{((Number(items[active].value) || 0) / sum * 100).toFixed(1)}% of stock value</span>
          )}
        </div>
      </div>
      <ul className="donut-legend">
        {items.map((item, i) => (
          <li
            key={item.label}
            className={active === i ? 'active' : ''}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
          >
            <i className="swatch" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="donut-legend-label">{item.label}</span>
            <span className="donut-legend-value">{formatter(Number(item.value) || 0)}</span>
            <span className="donut-legend-share">{((Number(item.value) || 0) / sum * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Horizontal bars that sweep out to their value, staggered top to bottom. */
export function RankBars({ items, valueKey = 'stock_value', labelKey = 'name', metaKey, formatter = money, tone = 'accent' }) {
  const grown = useGrowIn(`${tone}|${items?.map((i) => i[valueKey]).join(',') ?? ''}`)
  if (!items?.length) return <Empty title="Nothing to rank yet" />
  const max = Math.max(...items.map((i) => Number(i[valueKey]) || 0), 1)
  return (
    <ul className="rank">
      {items.map((item, i) => (
        <li key={item.id ?? item[labelKey] ?? i} style={{ '--i': i }}>
          <div className="rank-row">
            <span className="rank-label">{item[labelKey]}</span>
            <span className="rank-value">{formatter(Number(item[valueKey]) || 0)}</span>
          </div>
          <div className="rank-track">
            <div
              className={`rank-fill rank-${tone}`}
              style={{
                width: grown ? `${Math.max(2, ((Number(item[valueKey]) || 0) / max) * 100)}%` : '0%',
                transition: `width 900ms cubic-bezier(.22,1,.36,1) ${i * 60}ms`,
              }}
            />
          </div>
          {metaKey && <span className="rank-meta">{metaKey(item)}</span>}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------- gauges, meters, rings -- */

const polar = (cx, cy, r, deg) => {
  const t = (deg * Math.PI) / 180
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
}

const arcPath = (cx, cy, r, from, to) => {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

const clampShare = (v, max) => Math.max(0, Math.min(1, (Number(v) || 0) / (max || 1)))

/**
 * 270° gauge: the arc, its ticks and a travelling dot all follow one eased
 * progress value, so the whole instrument sweeps in together.
 */
export function Gauge({ value = 0, max = 100, label = 'Score', grade, caption, size = 208 }) {
  const target = Math.max(0, Math.min(max, Number(value) || 0))
  const progress = useProgress(`${target}|${max}`, 1300)
  const shown = clampShare(target, max) * progress
  const START = 135
  const SWEEP = 270
  const cx = 100
  const cy = 100
  const R = 74
  const end = START + SWEEP * shown
  const gid = useId().replace(/:/g, '')
  const [dotX, dotY] = polar(cx, cy, R, end)
  const ticks = Array.from({ length: 28 }, (_, i) => START + (SWEEP * i) / 27)

  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox="0 0 200 200" role="img" aria-label={`${label}: ${target} of ${max}`}>
        <defs>
          <linearGradient id={`gauge-${gid}`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--c2)" />
            <stop offset="52%" stopColor="var(--c1)" />
            <stop offset="100%" stopColor="var(--c3)" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => {
          const on = t <= end + 0.001
          const [x1, y1] = polar(cx, cy, R + (i % 9 === 0 ? 3 : 7), t)
          const [x2, y2] = polar(cx, cy, R + 13, t)
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} className={`gauge-tick ${on ? 'on' : ''} ${i % 9 === 0 ? 'major' : ''}`} />
        })}
        <path d={arcPath(cx, cy, R, START, START + SWEEP)} className="gauge-track" />
        <path
          d={arcPath(cx, cy, R, START, START + SWEEP)} className="gauge-value" fill="none"
          stroke={`url(#gauge-${gid})`} pathLength="1"
          style={{ strokeDasharray: 1, strokeDashoffset: 1 - shown }}
        />
        <circle className="gauge-dot" cx={dotX} cy={dotY} r={5.5} />
      </svg>
      <div className="gauge-center">
        <span className="gauge-label">{label}</span>
        <strong className="gauge-number"><AnimatedNumber value={target} format={(v) => String(Math.round(v))} duration={1300} /></strong>
        {grade && <span className="gauge-grade">{grade}</span>}
        {caption && <span className="gauge-caption">{caption}</span>}
      </div>
    </div>
  )
}

/** Compact circular progress used in the health KPI strip. */
export function RingStat({ value = 0, max = 100, label, sub, unit = '%', tone = 'accent', size = 58 }) {
  const progress = useProgress(`${value}|${max}`, 1100)
  const share = clampShare(value, max)
  const R = 22
  const C = 2 * Math.PI * R
  return (
    <div className={`ring-stat ring-${tone}`} data-testid="ring-stat">
      <div className="ring" style={{ width: size, height: size }}>
        <svg viewBox="0 0 52 52" aria-hidden="true">
          <circle cx="26" cy="26" r={R} className="ring-track" />
          <circle
            cx="26" cy="26" r={R} className="ring-value" strokeDasharray={C}
            strokeDashoffset={C * (1 - share * progress)} transform="rotate(-90 26 26)"
          />
        </svg>
        <span className="ring-number">
          <AnimatedNumber value={Number(value) || 0} format={(v) => nf.format(Math.round(v))} />
          {unit && <i>{unit}</i>}
        </span>
      </div>
      <div className="ring-copy">
        <span className="ring-label">{label}</span>
        {sub && <small>{sub}</small>}
      </div>
    </div>
  )
}

/** Labelled meters — used for the health score's dimensions. */
export function MeterList({ items = [], max = 100, format = (v) => `${Math.round(v)}/100` }) {
  const grown = useGrowIn(items.map((i) => `${i.label}:${i.value}`).join('|'))
  return (
    <ul className="meters">
      {items.map((item, i) => (
        <li key={item.key ?? item.label} className={`meter meter-${item.tone ?? 'accent'}`} style={{ '--i': i }}>
          <div className="meter-head">
            <span className="meter-label">{item.label}</span>
            <span className="meter-value">{item.valueLabel ?? format(item.value)}</span>
          </div>
          <div className="meter-track">
            <span style={{ width: grown ? `${clampShare(item.value, item.max ?? max) * 100}%` : '0%' }} />
          </div>
          {item.hint && <span className="meter-hint">{item.hint}</span>}
        </li>
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------- treemap -- */

/** Binary-split treemap layout: alternates the split axis to stay near-square. */
function treemapRects(items, x, y, w, h, out = []) {
  if (!items.length) return out
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return out }
  const total = items.reduce((sum, i) => sum + i.value, 0)
  let acc = 0
  let split = 1
  let best = Infinity
  for (let i = 0; i < items.length - 1; i += 1) {
    acc += items[i].value
    const diff = Math.abs(acc / total - 0.5)
    if (diff < best) { best = diff; split = i + 1 }
  }
  const first = items.slice(0, split)
  const rest = items.slice(split)
  const ratio = first.reduce((sum, i) => sum + i.value, 0) / total
  if (w >= h) {
    treemapRects(first, x, y, w * ratio, h, out)
    treemapRects(rest, x + w * ratio, y, w - w * ratio, h, out)
  } else {
    treemapRects(first, x, y, w, h * ratio, out)
    treemapRects(rest, x, y + h * ratio, w, h - h * ratio, out)
  }
  return out
}

/** Squarified category map: capital concentration at a glance. */
export function Treemap({ items = [], formatter = money, height = 280, unit = '' }) {
  const [active, setActive] = useState(null)
  const grown = useGrowIn(items.map((i) => `${i.label}:${i.value}`).join('|'))
  const rows = items
    .map((item, i) => ({ ...item, value: Math.max(0, Number(item.value) || 0), index: i }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
  if (!rows.length) return <Empty title="No value to map yet" />

  const total = rows.reduce((sum, i) => sum + i.value, 0)
  const rects = treemapRects(rows, 0, 0, 100, 100)
  const current = active !== null ? rows.find((r) => r.label === active) : null

  return (
    <div className="treemap" style={{ height }}>
      <div className="treemap-map">
      {rects.map((rect, i) => {
        const share = (rect.value / total) * 100
        const big = share >= 9
        return (
          <button
            key={rect.label}
            type="button"
            className={`treemap-cell ${active === rect.label ? 'active' : ''}`}
            style={{
              left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%`,
              background: CHART_COLORS[rect.index % CHART_COLORS.length],
              '--i': i, transform: grown ? 'scale(1)' : 'scale(0.86)', opacity: grown ? 1 : 0,
            }}
            onMouseEnter={() => setActive(rect.label)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(rect.label)}
            onBlur={() => setActive(null)}
          >
            <span className="treemap-name">{rect.label}</span>
            {big && <span className="treemap-value">{formatter(rect.value)}{unit}</span>}
            <span className="treemap-share">{share.toFixed(1)}%</span>
          </button>
        )
      })}
      </div>
      <div className="treemap-readout">
        {current
          ? <><strong>{current.label}</strong><span>{formatter(current.value)} · {((current.value / total) * 100).toFixed(1)}% of value</span></>
          : <span className="muted">{rows.length} categories · {formatter(total)} total</span>}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- heatmap -- */

/** Week × weekday intensity grid with a live readout. */
export function Heatmap({ weeks = [], weekdays = [], cells = [], valueKey = 'units_out', formatter = (v) => nf.format(v), unit = 'units' }) {
  const lookup = useMemo(() => new Map(cells.map((c) => [`${c.week}|${c.weekday}`, c])), [cells])
  const max = Math.max(1, ...cells.map((c) => Number(c[valueKey]) || 0))
  const [hover, setHover] = useState(null)
  const grown = useGrowIn(`${weeks.join(',')}|${cells.length}|${max}`)
  if (!weeks.length) return <Empty title="No activity in this period" hint="Widen the reporting window to see the pattern." />

  return (
    <div className="heat">
      <div className="heat-readout" aria-live="polite">
        {hover
          ? <><strong>{hover.weekday}</strong> · {hover.week} — <strong>{formatter(hover.value)}</strong> {unit}{hover.movements ? ` · ${nf.format(hover.movements)} movements` : ''}</>
          : <span className="muted">Hover a cell for the daily detail</span>}
      </div>
      <div className="heat-body">
        <div className="heat-rows">
          {weekdays.map((d) => <span key={d.id} className="heat-row-label">{d.label}</span>)}
        </div>
        <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
          {weekdays.map((d, row) => (
            <Fragment key={d.id}>
              {weeks.map((w, col) => {
                const cell = lookup.get(`${w}|${d.id}`)
                const value = cell ? Number(cell[valueKey]) || 0 : 0
                const t = value / max
                return (
                  <span
                    key={`${w}-${d.id}`}
                    className={`heat-cell ${hover && hover.week === w && hover.weekdayId === d.id ? 'active' : ''}`}
                    data-empty={value === 0 ? 'true' : 'false'}
                    style={{ '--i': col + row * weeks.length, '--t': grown ? t : 0 }}
                    onMouseEnter={() => setHover({ week: w, weekday: d.label, weekdayId: d.id, value, movements: cell?.movements ?? 0 })}
                    onMouseLeave={() => setHover(null)}
                    title={`${d.label} ${w}: ${formatter(value)} ${unit}`}
                  />
                )
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="heat-legend">
        <span className="muted small">Low</span>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <i key={t} className="heat-swatch" style={{ '--t': t }} />
        ))}
        <span className="muted small">High</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ column sets */

/** Waterfall of stock in / out / net for the period. */
export function Waterfall({ items = [], height = 250, formatter = (v) => nf.format(v) }) {
  const grown = useGrowIn(items.map((i) => `${i.label}:${i.value}:${i.type}`).join('|'))
  let run = 0
  const bars = items.map((item) => {
    const value = Math.abs(Number(item.value) || 0)
    if (item.type === 'total') return { ...item, from: 0, to: run, value: Math.abs(run), isTotal: true }
    const from = run
    run += item.type === 'in' ? value : -value
    return { ...item, from, to: run, value }
  })
  if (!bars.length) return <Empty title="Nothing to plot" />
  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)))
  const hi = Math.max(1, ...bars.map((b) => Math.max(b.from, b.to)))
  const span = hi - lo || 1
  return (
    <div className="waterfall" style={{ height }}>
      <div className="waterfall-plot">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => <span key={t} className="waterfall-grid" style={{ bottom: `${t * 100}%` }} />)}
        {bars.map((b, i) => {
          const bottom = ((Math.min(b.from, b.to) - lo) / span) * 100
          const size = (Math.abs(b.to - b.from) / span) * 100
          return (
            <div
              key={b.label + i}
              className={`waterfall-col waterfall-${b.isTotal ? 'total' : b.type}`}
              style={{ left: `${(i + 0.5) / bars.length * 100}%`, width: `${(1 / bars.length) * 62}%` }}
            >
              <span
                className="waterfall-bar"
                style={{
                  bottom: grown ? `${bottom}%` : '0%',
                  height: grown ? `${Math.max(1, size)}%` : '0%',
                  transition: `height 820ms cubic-bezier(.22,1,.36,1) ${i * 70}ms, bottom 820ms cubic-bezier(.22,1,.36,1) ${i * 70}ms`,
                }}
              >
                <em className="waterfall-label">{formatter(b.value)}</em>
              </span>
              <span className="waterfall-name">{b.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Stacked columns with hover detail — composition of in vs out per bucket. */
export function StackedBars({ data = [], keys = [], height = 250, formatter = (v) => nf.format(v), unit = 'units' }) {
  const [hover, setHover] = useState(null)
  const totals = data.map((d) => keys.reduce((sum, k) => sum + (Number(d[k.key]) || 0), 0))
  const grown = useGrowIn(`${data.length}|${totals.join(',')}`)
  if (!data.length) return <Empty title="No activity in this period" />
  const max = niceMax(Math.max(1, ...totals))
  return (
    <div className="stack-chart">
      <div className="stack-plot" style={{ height }}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <div key={t} className="stack-gridline" style={{ bottom: `${t * 100}%` }}>
            <span className="axis">{compact(max * t)}</span>
          </div>
        ))}
        {data.map((row, i) => {
          const total = totals[i] || 0
          return (
            <div
              key={row.label} className="stack-col"
              style={{ width: `${100 / data.length}%`, left: `${(i / data.length) * 100}%` }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            >
              <div
                className={`stack-fill ${hover === i ? 'active' : ''}`}
                style={{
                  height: `${(total / max) * 100}%`,
                  transform: grown ? 'scaleY(1)' : 'scaleY(0)',
                  transition: `transform 760ms cubic-bezier(.22,1,.36,1) ${i * 24}ms`,
                }}
              >
                {keys.map((k) => (
                  <span
                    key={k.key}
                    className={`stack-seg stack-${k.tone ?? k.key}`}
                    style={{ height: `${total > 0 ? ((Number(row[k.key]) || 0) / total) * 100 : 0}%` }}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div className="stack-axis">
        {data.map((row, i) => (
          <span key={row.label} className="stack-axis-label">{i % Math.ceil(data.length / 8) === 0 ? row.label : ''}</span>
        ))}
      </div>
      <div className="stack-foot">
        <div className="legend">
          {keys.map((k) => <span key={k.key} className="legend-item"><i className="swatch" style={{ background: k.color }} />{k.label}</span>)}
        </div>
        <div className="stack-readout">
          {hover !== null
            ? <>{data[hover].label} — {keys.map((k) => `${k.label}: ${formatter(Number(data[hover][k.key]) || 0)}`).join(' · ')}</>
            : <span className="muted">{data.length} buckets · hover a column</span>}
        </div>
      </div>
    </div>
  )
}

/** Compact vertical bars — the hour-of-day profile. */
export function MiniBars({ data = [], height = 130, formatter = (v) => nf.format(v), labelKey = 'label', valueKey = 'value', unit = 'units' }) {
  const [hover, setHover] = useState(null)
  const grown = useGrowIn(data.map((d) => d[valueKey]).join(','))
  if (!data.length) return <Empty title="Nothing to plot" />
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0))
  return (
    <div className="minibars">
      <div className="minibars-readout">
        {hover !== null
          ? <><strong>{data[hover][labelKey]}</strong> — {formatter(Number(data[hover][valueKey]) || 0)} {unit}</>
          : <span className="muted">Hover a bar for detail</span>}
      </div>
      <div className="minibars-plot" style={{ height }}>
        {data.map((d, i) => {
          const value = Number(d[valueKey]) || 0
          return (
            <span
              key={d[labelKey]} className={`minibar ${hover === i ? 'active' : ''}`}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ '--i': i }}
            >
              <i style={{
                height: grown ? `${Math.max(2, (value / max) * 100)}%` : '0%',
                transition: `height 700ms cubic-bezier(.22,1,.36,1) ${i * 16}ms`,
              }} />
            </span>
          )
        })}
      </div>
      <div className="minibars-axis">
        {data.map((d, i) => <span key={d[labelKey]}>{i % 4 === 0 ? d[labelKey] : ''}</span>)}
      </div>
    </div>
  )
}
