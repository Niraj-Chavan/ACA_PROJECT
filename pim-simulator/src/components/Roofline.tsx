import type { Result, Params, Workload } from '../engine/types'
import { LineChart, type Pt } from './Charts'
import { workloadById } from '../engine/workloads'

/**
 * Roofline (log–log): attainable performance roofs for CPU and PIM, plus the
 * workload's arithmetic-intensity operating point.
 */
export function Roofline({
  result,
  params,
  workloadId,
}: {
  result: Result
  params: Params
  workloadId: Workload | string
}) {
  const wl = typeof workloadId === 'string' ? workloadById(workloadId) : workloadId
  const peakCpu = params.cpu.cores * params.cpu.freqGHz * 1e9 * params.cpu.opsPerCycle
  const peakPim = params.pim.banks * params.pim.unitsPerBank * params.pim.freqGHz * 1e9 * params.pim.opsPerCycle
  const bwCpu = params.cpu.memBWGBs * 1e9
  const bankBw = params.pim.banks * params.pim.unitsPerBank * params.pim.bankBWGBs * 1e9
  const ridgeCpu = peakCpu / bwCpu
  const ridgePim = peakPim / bankBw

  const n = result.n
  const t = wl.computeTotals(n, result.units)
  const bytesPerElem = (t.readBytes + t.writtenBytes) / Math.max(n, 1)
  const opsPerElem = t.ops / Math.max(n, 1)
  const ai = opsPerElem / Math.max(bytesPerElem, 1e-9)

  // AI line for this workload across sizes
  const aiPoints: Pt[] = [256, 4096, 1 << 16, 1 << 20, 1 << 24, 1 << 28].flatMap((nn) => {
    const tt = wl.computeTotals(nn, result.units)
    const bb = (tt.readBytes + tt.writtenBytes) / nn
    const oo = tt.ops / nn
    return [{ x: oo / Math.max(bb, 1e-9), y: peakCpu }]
  }).map((p) => ({ x: p.x, y: p.y }))

  const cpuRoof: Pt[] = [{ x: 0.01, y: bwCpu * 0.01 }, ...[0.05, ridgeCpu].map((x) => ({ x, y: bwCpu * x })), { x: ridgeCpu, y: peakCpu }, { x: 1000, y: peakCpu }]
  const pimRoof: Pt[] = [{ x: 0.01, y: bankBw * 0.01 }, ...[0.05, ridgePim].map((x) => ({ x, y: bankBw * x })), { x: ridgePim, y: peakPim }, { x: 1000, y: peakPim }]

  return (
    <div className="panel">
      <h3>Roofline</h3>
      <LineChart
        xLabel="arithmetic intensity (ops/byte)"
        yLabel="ops/s"
        logX
        logY
        series={[
          { points: cpuRoof, color: 'var(--cpu)', label: 'CPU roof' },
          { points: pimRoof, color: 'var(--pim)', label: 'PIM roof' },
          { points: aiPoints, color: 'var(--muted)', label: 'workload AI', dashed: true },
        ]}
        markers={[{ x: ai, y: Math.min(peakCpu, bwCpu * Math.max(ai, 0.01)), color: 'var(--accent)', label: 'this run (CPU)' }]}
      />
      <p className="fineprint">
        Ridge: CPU at {ridgeCpu.toFixed(2)} ops/B, PIM at {ridgePim.toFixed(2)} ops/B. Workload AI ={' '}
        {ai.toFixed(2)} ops/B — {ai < ridgeCpu ? 'left of the ridge ⇒ memory-bound' : 'right of the ridge ⇒ compute-bound'}.
      </p>
    </div>
  )
}
