import { useMemo } from 'react'
import { logspace, sweep, type SweepRow } from '../engine/sweep'
import { fmtSpeedup } from '../engine/format'
import { LineChart, type Pt } from './Charts'
import type { AppState, PerfTab } from '../state/store'

const COLORS = { cpu: 'var(--cpu)', pim: 'var(--pim)' }

function seriesFrom(rows: SweepRow[], pick: (r: SweepRow) => number): { points: Pt[]; color: string; label: string }[] {
  return [
    { points: rows.map((r) => ({ x: r.sweepValue, y: pick(r) === undefined ? NaN : pick(r) })), color: COLORS.cpu, label: 'CPU' },
  ]
}

export function PerformanceGraphs({ state, tab, setTab }: { state: AppState; tab: PerfTab; setTab: (t: PerfTab) => void }) {
  const rows = useMemo(() => {
    const sizes = logspace(1024, 10 * 1024 ** 3, 26) // bytes
    return sweep(state.params, workloadOf(state.workloadId), 'dataSize', sizes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.params,
    state.workloadId,
    state.params.dataResident,
    state.params.resultNeededOnHost,
    state.params.pim.banks,
    state.params.pim.unitsPerBank,
    state.params.pim.freqGHz,
    state.params.cpu.memBWGBs,
    state.params.cpu.cores,
  ])

  const tabs: { id: PerfTab; label: string }[] = [
    { id: 'time', label: 'Time' },
    { id: 'speedup', label: 'Speedup' },
    { id: 'data', label: 'Data movement' },
    { id: 'energy', label: 'Energy' },
    { id: 'throughput', label: 'Throughput' },
  ]

  return (
    <div className="panel perf-graphs">
      <div className="tab-row">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="perf-chart-body">
        {tab === 'time' && (
          <LineChart
            xLabel="data size (bytes)"
            yLabel="execution time (s)"
            series={[
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.cpuTime })), color: COLORS.cpu, label: 'CPU' },
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.pimTime })), color: COLORS.pim, label: 'PIM' },
            ]}
          />
        )}
        {tab === 'speedup' && (
          <LineChart
            xLabel="data size (bytes)"
            yLabel="speedup (×)"
            series={[{ points: rows.map((r) => ({ x: r.sweepValue, y: r.speedup })), color: COLORS.pim, label: 'PIM' }]}
            logY={false}
            markers={[{ x: rows[0]?.sweepValue ?? 1, y: 1, color: 'var(--muted)', label: 'break-even', shape: 'diamond' }]}
          />
        )}
        {tab === 'data' && (
          <LineChart
            xLabel="data size (bytes)"
            yLabel="bytes over the bus"
            series={seriesFrom(rows, (r) => r.cpuBytes).concat([
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.pimOffchipBytes })), color: COLORS.pim, label: 'PIM' },
            ])}
          />
        )}
        {tab === 'energy' && (
          <LineChart
            xLabel="data size (bytes)"
            yLabel="energy (J)"
            series={[
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.cpuEnergy })), color: COLORS.cpu, label: 'CPU' },
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.pimEnergy })), color: COLORS.pim, label: 'PIM' },
            ]}
          />
        )}
        {tab === 'throughput' && (
          <LineChart
            xLabel="data size (bytes)"
            yLabel="throughput (ops/s)"
            series={[
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.cpuThroughput })), color: COLORS.cpu, label: 'CPU' },
              { points: rows.map((r) => ({ x: r.sweepValue, y: r.pimThroughput })), color: COLORS.pim, label: 'PIM' },
            ]}
          />
        )}
      </div>
      <div className="legend-row">
        <span className="legend-swatch" style={{ background: COLORS.cpu }} /> CPU
        <span className="legend-swatch" style={{ background: COLORS.pim }} /> PIM
        <span className="fineprint">speedup at 10 GB: {fmtSpeedup(rows[rows.length - 1]?.speedup ?? 0)}</span>
      </div>
    </div>
  )
}

function workloadOf(id: string) {
  // local import avoided circular: engine workloads are pure data
  const mod = workloadCache
  return mod(id)
}

import { workloadById } from '../engine/workloads'
function workloadCache(id: string) {
  return workloadById(id)
}
