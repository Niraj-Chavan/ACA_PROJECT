import type { ReactNode } from 'react'

/** log-spaced tick helper */
export function niceTicks(
  min: number,
  max: number,
  logScale: boolean
): { v: number; label: string }[] {
  const fmt = (v: number) =>
    v >= 1000 ? `${(v / 1000).toLocaleString()}k` : v >= 1 ? `${v}` : v.toExponential(0)
  if (!logScale) {
    return [min, min + (max - min) / 2, max].map((v) => ({ v, label: fmt(v) }))
  }
  const lmin = Math.log10(Math.max(min, 1e-12))
  const lmax = Math.log10(Math.max(max, 1e-9))
  const out: { v: number; label: string }[] = []
  const step = Math.max(1, Math.round((lmax - lmin) / 4))
  for (let e = Math.ceil(lmin); e <= Math.floor(lmax); e += step) {
    const v = Math.pow(10, e)
    out.push({ v, label: fmt(v) })
  }
  return out
}

export interface Pt {
  x: number
  y: number
}

export function LineChart({
  series,
  width = 460,
  height = 240,
  logX = true,
  logY = true,
  xLabel,
  yLabel,
  markers,
  children,
}: {
  series: { points: Pt[]; color: string; label: string; dashed?: boolean }[]
  width?: number
  height?: number
  logX?: boolean
  logY?: boolean
  xLabel?: string
  yLabel?: string
  markers?: { x: number; y: number; color: string; label: string; shape?: 'circle' | 'diamond' }[]
  children?: ReactNode
}) {
  const m = { l: 56, r: 16, t: 12, b: 40 }
  const w = width - m.l - m.r
  const h = height - m.t - m.b
  const pts = series.flatMap((s) => s.points).filter((p) => isFinite(p.x) && isFinite(p.y) && p.x > 0 && p.y > 0) 
  if (pts.length === 0) return <div className="chart-empty">No data</div>
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const tx = (v: number) => {
    const a = logX ? Math.log10(Math.max(v, 1e-12)) : v
    const lo = logX ? Math.log10(minX) : minX
    const hi = logX ? Math.log10(maxX) : maxX
    return m.l + ((a - lo) / Math.max(hi - lo, 1e-12)) * w
  }
  const ty = (v: number) => {
    const a = logY ? Math.log10(Math.max(v, 1e-12)) : v
    const lo = logY ? Math.log10(minY) : minY
    const hi = logY ? Math.log10(maxY) : maxY
    return m.t + h - ((a - lo) / Math.max(hi - lo, 1e-12)) * h
  }
  const xTicks = niceTicks(minX, maxX, logX)
  const yTicks = niceTicks(minY, maxY, logY)
  const fmtX = (v: number) =>
    v >= 1e9 ? `${v.toExponential(0)}` : v >= 1024 * 1024 * 100 ? `${Math.round(v / 1024 ** 2)}M(B)` : v >= 1024 ? `${Math.round(v / 1024)}K(B)` : `${v}`
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="chart">
      {yTicks.map((t) => (
        <g key={`y${t.v}`}>
          <line x1={m.l} x2={m.l + w} y1={ty(t.v)} y2={ty(t.v)} className="gridline" />
          <text x={m.l - 6} y={ty(t.v) + 3} textAnchor="end" className="tick">{t.label}</text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t.v}`}>
          <line x1={tx(t.v)} x2={tx(t.v)} y1={m.t} y2={m.t + h} className="gridline" />
          <text x={tx(t.v)} y={m.t + h + 14} textAnchor="middle" className="tick">{fmtX(t.v)}</text>
        </g>
      ))}
      {markers?.map((mk, i) => (
        <g key={`mk${i}`}>
          {mk.shape === 'diamond' ? (
            <rect
              x={tx(mk.x) - 6}
              y={ty(mk.y) - 3}
              width={12}
              height={6}
              transform={`rotate(45 ${tx(mk.x)} ${ty(mk.y)})`}
              fill={mk.color}
            />
          ) : (
            <circle cx={tx(mk.x)} cy={ty(mk.y)} r={5} fill={mk.color} stroke="var(--bg)" strokeWidth={1.5} />
          )}
          {mk.label && (
            <text x={tx(mk.x)} y={ty(mk.y) - 10} textAnchor="middle" fontSize={10} fill={mk.color}>
              {mk.label}
            </text>
          )}
        </g>
      ))}
      {series.map((s, i) =>
        s.points.length > 1 ? (
          <polyline
            key={i}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            points={s.points
              .filter((p) => isFinite(p.x) && isFinite(p.y) && p.x > 0 && p.y > 0)
              .map((p) => `${tx(p.x)},${ty(p.y)}`)
              .join(' ')}
          />
        ) : null
      )}
      {xLabel && <text x={m.l + w / 2} y={height - 4} textAnchor="middle" className="axis-label">{xLabel}</text>}
      {yLabel && (
        <text x={12} y={m.t + h / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 12 ${m.t + h / 2})`}>
          {yLabel}
        </text>
      )}
      {children}
    </svg>
  )
}

export function HBars({
  rows,
  max,
  fmt,
}: {
  rows: { label: string; value: number; color: string }[]
  max?: number
  fmt: (v: number) => string
}) {
  const mx = max ?? Math.max(...rows.map((r) => r.value), 1e-12)
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.label} className="hbar-row">
          <span className="hbar-label">{r.label}</span>
          <div className="hbar-track">
            <div
              className="hbar-fill"
              style={{ width: `${Math.max(100 * (r.value / mx), 0.5)}%`, background: r.color }}
            />
            <span className="hbar-value">{fmt(r.value)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Gauge({ score, label }: { score: number; label: string }) {
  const r = 52
  const cx = 60
  const cy = 60
  const circ = Math.PI * r // half circle
  const frac = Math.max(0, Math.min(1, score / 100))
  const color = score >= 70 ? 'var(--good)' : score >= 45 ? 'var(--warn)' : 'var(--bad)'
  return (
    <div className="gauge-wrap">
      <svg width={120} height={78} viewBox="0 0 120 78">
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--border)"
          strokeWidth={10}
          strokeLinecap="round"
        />
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${circ * frac} ${circ}`}
        />
        <text x={cx} y={cy - 8} textAnchor="middle" className="gauge-number" fill={color}>
          {score}
        </text>
      </svg>
      <div className="gauge-label" style={{ color }}>{label}</div>
    </div>
  )
}

export function FactorBars({
  factors,
}: {
  factors: { name: string; value: number }[]
}) {
  return (
    <div className="factor-bars">
      {factors.map((f) => (
        <div key={f.name} className="factor-row" title={`${f.name}: ${(f.value * 100).toFixed(0)}%`}>
          <span className="factor-name">{f.name}</span>
          <div className="factor-track">
            <div className="factor-fill" style={{ width: `${f.value * 100}%` }} />
          </div>
          <span className="factor-val">{(f.value * 100).toFixed(0)}</span>
        </div>
      ))}
    </div>
  )
}
