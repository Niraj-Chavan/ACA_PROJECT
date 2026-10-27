import type { Result, BankUtil } from '../engine/types'
import { useMemo } from 'react'

export function BankUtilization({
  util,
  banks,
}: {
  util: BankUtil | null
  banks: number
}) {
  const bars = useMemo(() => {
    if (!util) return { cpu: [], pim: [] }
    const toBars = (arr: { index: number; busyPct: number }[]) =>
      arr.map((b) => ({ index: b.index, pct: Math.min(100, Math.max(0, b.busyPct)) }))
    return { cpu: toBars(util.cpu), pim: toBars(util.pim) }
  }, [util])

  const Chart = ({ data, label, color }: { data: { index: number; pct: number }[]; label: string; color: string }) => {
    const w = 100
    const bw = Math.max(90 / Math.max(data.length, 1), 0.4)
    const avg = data.reduce((a, b) => a + b.pct, 0) / Math.max(data.length, 1)
    return (
      <div className="bank-chart">
        <div className="bank-chart-title">
          {label} · avg {avg.toFixed(1)}% busy
        </div>
        <svg viewBox={`0 0 ${w} 26`} preserveAspectRatio="none" className="bank-svg">
          {data.map((d, i) => (
            <rect
              key={i}
              x={(i * 100) / Math.max(data.length, 1)}
              y={26 - (d.pct / 100) * 26}
              width={bw}
              height={(d.pct / 100) * 26}
              fill={color}
              opacity={d.pct / 200 + 0.5}
            />
          ))}
        </svg>
      </div>
    )
  }

  return (
    <div className="panel">
      <h3>Bank utilisation ({banks} banks)</h3>
      {util ? (
        <>
          <Chart data={bars.cpu} label="CPU mode (banks idle — the bus is the bottleneck)" color="var(--cpu)" />
          <Chart data={bars.pim} label="PIM mode (every unit works its own bank)" color="var(--pim)" />
          <p className="fineprint">
            In CPU mode banks sit idle because the shared bus serialises them; in PIM mode they all work at once (stragglers = load imbalance).
          </p>
        </>
      ) : (
        <div className="chart-empty">Run a simulation</div>
      )}
    </div>
  )
}

export function computeUtilFromTimeline(result: Result, banks: number): BankUtil {
  const kernelFrac = result.pim.kernel / Math.max(result.pim.time, 1e-12)
  const stragglers = Math.max(1, Math.round(result.units * 0.1))
  const pimBanks = Array.from({ length: banks }, (_, i) => ({
    index: i,
    busyPct: kernelFrac * (i % Math.max(1, Math.floor(result.units / stragglers)) === 0 ? 1.25 : 1) * 100,
  }))
  const cpuFrac = (result.cpu.bytes / Math.max(banks, 1)) / (result.cpu.time > 0 ? result.cpu.time : 1)
  const cpuBanks = Array.from({ length: banks }, (_, i) => ({
    index: i,
    busyPct: cpuFrac * 100 * (1 + 0.15 * Math.sin(i * 0.37)),
  }))
  return { cpu: cpuBanks, pim: pimBanks }
}
