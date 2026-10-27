import type { Result } from '../engine/types'
import { fmtEnergy } from '../engine/format'

function StackedBar({
  parts,
  label,
}: {
  parts: { value: number; color: string; name: string; title: string }[]
  label: string
}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1
  return (
    <div className="stacked">
      <div className="stacked-label">{label}</div>
      <div className="stacked-track">
        {parts.map((p) => (
          <div
            key={p.name}
            className="stacked-seg"
            title={`${p.title}: ${((p.value / total) * 100).toFixed(1)}%`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))}
      </div>
      <div className="stacked-legend">
        {parts.filter((p) => p.value / total > 0.005).map((p) => (
          <span key={p.name} className="legend-item">
            <span className="legend-swatch" style={{ background: p.color }} />
            {p.title} {(p.value / total) * 100 < 99.5 ? `${((p.value / total) * 100).toFixed(0)}%` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

const C = {
  cpuCompute: 'var(--cpu-hi)',
  cpuMem: 'var(--cpu)',
  copyIn: 'var(--copy)',
  kernel: 'var(--pim-hi)',
  merge: 'var(--merge)',
  copyOut: 'var(--cout)',
}

export function TimeBreakdown({ result }: { result: Result }) {
  const cpuMem = result.cpu.memTime
  const cpuOverlap = Math.max(0, result.cpu.time - result.cpu.memTime)
  return (
    <div className="panel">
      <h3>Time breakdown</h3>
      <StackedBar
        label="CPU"
        parts={[
          { value: cpuOverlap, color: C.cpuCompute, name: 'cc', title: 'Compute' },
          { value: cpuMem, color: C.cpuMem, name: 'cm', title: 'Waiting on memory' },
        ]}
      />
      <StackedBar
        label="PIM"
        parts={[
          { value: result.pim.copyIn, color: C.copyIn, name: 'ci', title: 'Copy-in (+launch)' },
          { value: result.pim.kernel, color: C.kernel, name: 'k', title: 'PIM kernel' },
          { value: result.pim.merge, color: C.merge, name: 'm', title: 'Merge partials' },
          { value: result.pim.copyOut, color: C.copyOut, name: 'co', title: 'Copy-out' },
        ]}
      />
    </div>
  )
}

export function EnergyBreakdown({ result }: { result: Result }) {
  const parts = (e: Result['cpu']['energy']) => [
    { v: e.movement, c: 'var(--e-move)', t: 'Off-chip movement' },
    { v: e.inBank, c: 'var(--e-bank)', t: 'In-bank access' },
    { v: e.compute, c: 'var(--e-comp)', t: 'Compute' },
    { v: e.static, c: 'var(--e-stat)', t: 'Static' },
  ]
  const cpu = result.cpu.energy
  const pim = result.pim.energy
  const tot = (e: Result['cpu']['energy']) => e.movement + e.inBank + e.compute + e.static
  return (
    <div className="panel">
      <h3>Energy breakdown</h3>
      <StackedBar
        label={`CPU · ${fmtEnergy(tot(cpu))}`}
        parts={parts(cpu).map((p) => ({ value: p.v, color: p.c, name: p.t, title: p.t }))}
      />
      <StackedBar
        label={`PIM · ${fmtEnergy(tot(pim))}`}
        parts={parts(pim).map((p) => ({ value: p.v, color: p.c, name: p.t, title: p.t }))}
      />
      <p className="fineprint">Off-chip movement dominates CPU energy — that is the energy PIM removes.</p>
    </div>
  )
}
