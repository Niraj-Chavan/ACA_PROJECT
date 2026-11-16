import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/hooks'
import {
  loadRun,
  parseEventLines,
  reduceRun,
  runSequential,
  type RunState,
} from '../state/live'
import { simulate } from '../engine/simulate'
import { workloadById } from '../engine/workloads'
import { fmtBytes, fmtCount, fmtSpeedup, fmtTime } from '../engine/format'
import {
  crossoverCurve,
  firstCrossover,
  optimizeChunks,
  optimizeDpus,
} from '../engine/optimize'
import { comparePolicies } from '../engine/benchmark'
import { generateTasks, KIND_COLOR, KIND_INFO, type TaskKind } from '../engine/tasks'
import { LineChart } from '../components/Charts'

/**
 * Algorithm Lab.
 *
 * Upgrade 4 (real workload execution) and upgrade 5 (optimisation) live here.
 * Measured numbers come from the actual UPMEM DPU ISA running in the SDK
 * functional simulator; parallel composition, scaling and optimisation are
 * modelled and labelled as such.
 */

type Sub = 'workloads' | 'scaling' | 'optimization'

const SUBS: { id: Sub; label: string }[] = [
  { id: 'workloads', label: 'Workloads · sequential vs parallel' },
  { id: 'scaling', label: 'Scaling' },
  { id: 'optimization', label: 'Optimisation' },
]

interface KernelCard {
  id: string
  kind: TaskKind
  workloadId: string
  title: string
  strategy: string
  source: string
  demo: string
}

const KERNEL_CARDS: KernelCard[] = [
  {
    id: 'VA',
    kind: 'VA',
    workloadId: 'VA',
    title: 'Vector add',
    strategy: 'Each tasklet streams 256 B blocks of A and B, adds, writes C back.',
    source: 'pim-kernels/va',
    demo: 'VA-4dpu.jsonl',
  },
  {
    id: 'GEMV',
    kind: 'GEMV',
    workloadId: 'GEMV',
    title: 'Matrix–vector',
    strategy: 'Rows stay in MRAM; x is staged once into WRAM; one tasklet per row band.',
    source: 'pim-kernels/gemv',
    demo: 'GEMV-4dpu.jsonl',
  },
  {
    id: 'RED',
    kind: 'RED',
    workloadId: 'RED',
    title: 'Reduction',
    strategy: 'Tasklet partials, WRAM barrier, one partial per DPU merged on the host.',
    source: 'pim-kernels/red',
    demo: 'RED-4dpu.jsonl',
  },
  {
    id: 'SEARCH',
    kind: 'SEARCH',
    workloadId: 'SEL',
    title: 'Parallel search',
    strategy: 'Scan and count matches; one count per DPU merged on the host.',
    source: 'pim-kernels/search',
    demo: 'SEARCH-4dpu.jsonl',
  },
  {
    id: 'HIST',
    kind: 'HIST',
    workloadId: 'HST',
    title: 'Histogram',
    strategy: 'Private 256-bin histogram per tasklet, then one 256-bin partial per DPU.',
    source: 'pim-kernels/hist',
    demo: 'HIST-4dpu.jsonl',
  },
  {
    id: 'GEMM',
    kind: 'GEMM',
    workloadId: 'GEMM',
    title: 'Matrix multiply',
    strategy: 'Tiled C = A·B; rows of C are split across tasklets. Multiply-heavy.',
    source: 'pim-kernels/gemm',
    demo: 'GEMM-4dpu.jsonl',
  },
]

const KERNEL_BY_ID = Object.fromEntries(KERNEL_CARDS.map((k) => [k.id, k])) as Record<
  string,
  KernelCard
>

interface MeasuredPoint {
  dpus: number
  cycles: number
  ops: number
  n: number
  kernelS: number
}

const DPU_CHOICES = [1, 2, 4, 8, 16]
/** Nominal UPMEM DPU clock; perfcounter cycles are in these cycles. */
const DPU_CLOCK_GHZ = 0.35
const KIND_CHOICES: TaskKind[] = ['VA', 'GEMV', 'RED', 'SEARCH', 'HIST', 'GEMM']
const CROSS_N = [65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864]

const workloadIdForKind = (kind: TaskKind): string =>
  kind === 'SEARCH' ? 'SEL' : kind === 'HIST' ? 'HST' : kind

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

function RunSummary({ run }: { run: RunState }) {
  if (!run.meta) return <span className="chip info">no data</span>
  return (
    <span className="run-summary">
      <span className="chip info">{run.meta.dpus} DPUs</span>
      {run.dpu && <span className="chip pim">{run.dpu.cycles.toLocaleString()} cycles</span>}
      <span className="chip info">{run.totalMs.toFixed(1)} ms host phases</span>
      {run.error && <span className="chip warning">{run.error}</span>}
    </span>
  )
}

export function Lab() {
  const { state } = useStore()
  const [sub, setSub] = useState<Sub>('workloads')
  const [dpus, setDpus] = useState(4)
  const [selected, setSelected] = useState<string[]>(KERNEL_CARDS.map((k) => k.id))
  const [running, setRunning] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batch, setBatch] = useState<{ kernel: string; state: RunState }[]>([])
  const [single, setSingle] = useState<Record<string, RunState>>({})
  const [error, setError] = useState<string | null>(null)
  const [measured, setMeasured] = useState<Record<string, MeasuredPoint>>({})
  const [scaleKernel, setScaleKernel] = useState('VA')
  const [optKind, setOptKind] = useState<TaskKind>('VA')
  const abortRef = useRef<AbortController | null>(null)

  const params = state.params
  const totalElements = 1_000_000

  // Load bundled measured runs once. These are real DPU-simulator streams.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const map: Record<string, MeasuredPoint> = {}
      for (const card of KERNEL_CARDS) {
        const text = await loadRun(`demo:${card.demo}`)
        if (!text) continue
        const run = reduceRun(parseEventLines(text))
        if (!run.meta || !run.dpu) continue
        map[card.id] = {
          dpus: run.meta.dpus,
          cycles: run.dpu.cycles,
          ops: run.meta.ops,
          n: run.meta.n,
          kernelS: run.dpu.cycles / (DPU_CLOCK_GHZ * 1e9),
        }
      }
      if (!cancelled) setMeasured(map)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const runOne = async (id: string) => {
    setError(null)
    setRunning(id)
    abortRef.current = new AbortController()
    const [r] = await runSequential([id], dpus, undefined, abortRef.current.signal)
    setRunning(null)
    if (!r) return
    if (r.state.error) setError(r.state.error)
    setSingle((s) => ({ ...s, [id]: r.state }))
  }

  const runSelected = async () => {
    if (!selected.length) return
    setError(null)
    setBatch([])
    setBatchRunning(true)
    abortRef.current = new AbortController()
    const results = await runSequential(
      selected,
      dpus,
      (kernel, run) => {
        setBatch((prev) => [...prev.filter((r) => r.kernel !== kernel), { kernel, state: run }])
        if (run.error) setError(run.error)
      },
      abortRef.current.signal
    )
    setBatch(results)
    setBatchRunning(false)
  }

  const stopBatch = () => {
    abortRef.current?.abort()
    setBatchRunning(false)
  }

  const replayDemo = async (card: KernelCard) => {
    const text = await loadRun(`demo:${card.demo}`)
    if (!text) {
      setError(`No bundled demo ${card.demo} yet. Run ${card.id} with the bridge once to create it.`)
      return
    }
    setSingle((s) => ({ ...s, [card.id]: reduceRun(parseEventLines(text), { source: 'replay' }) }))
  }

  // ---- modelled parallel composition of the selected kernels ----------------
  const selectedCards = KERNEL_CARDS.filter((k) => selected.includes(k.id))
  const selectedKinds = selectedCards.map((k) => k.kind)
  const parallelTasks = useMemo(
    () =>
      generateTasks(params, {
        count: Math.max(8, selectedKinds.length * 4),
        totalElements: Math.max(1, selectedKinds.length) * totalElements,
        seed: 11,
        kinds: selectedKinds,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, selected.join(','), totalElements]
  )
  const parallel = useMemo(
    () => comparePolicies(parallelTasks, params, dpus),
    [parallelTasks, params, dpus]
  )
  const sequentialModelS = useMemo(() => {
    const p = JSON.parse(JSON.stringify(params)) as typeof params
    p.pim.banks = dpus
    p.pim.unitsPerBank = 1
    return selectedCards.reduce(
      (a, c) => a + simulate(p, workloadById(c.workloadId), totalElements).pim.time,
      0
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, dpus, selected.join(','), totalElements])

  const measuredBatch = batch.filter((r) => r.state.meta && r.state.dpu)
  const measuredSequentialKernelS = measuredBatch.reduce(
    (a, r) => a + (r.state.dpu?.cycles ?? 0) / (DPU_CLOCK_GHZ * 1e9),
    0
  )
  const parallelModelS = parallel.byPolicy.adaptive.schedule.makespanS

  // ---- scaling ---------------------------------------------------------------
  const scaleCard = KERNEL_BY_ID[scaleKernel]
  const scaleRows = useMemo(() => {
    const p = JSON.parse(JSON.stringify(params)) as typeof params
    p.pim.unitsPerBank = 1
    return DPU_CHOICES.map((d) => {
      p.pim.banks = d
      const r = simulate(p, workloadById(scaleCard.workloadId), d * 1_048_576)
      return { dpus: d, result: r }
    })
  }, [params, scaleCard.workloadId])
  const scaleSeries = scaleRows.map((r) => ({ x: r.dpus, y: r.result.pim.throughput }))
  const measuredAnchor = measured[scaleKernel]
  const measuredThroughput = measuredAnchor
    ? measuredAnchor.ops / measuredAnchor.kernelS
    : null

  // ---- optimisation ----------------------------------------------------------
  const dpuRows = useMemo(() => {
    const tasks = generateTasks(params, {
      count: 32,
      totalElements,
      seed: 5,
      only: optKind,
    })
    return optimizeDpus(params, tasks, DPU_CHOICES)
  }, [params, optKind, totalElements])
  const bestDpu = dpuRows.reduce((a, b) => (b.makespanS < a.makespanS ? b : a))
  const chunkRows = useMemo(
    () =>
      optimizeChunks(params, {
        totalElements,
        dpus: bestDpu.dpus,
        kind: optKind,
        counts: [4, 8, 16, 32, 64, 128],
        seed: 7,
      }),
    [params, optKind, totalElements, bestDpu.dpus]
  )
  const bestChunk = chunkRows.reduce((a, b) => (b.makespanS < a.makespanS ? b : a))
  const crossPoints = useMemo(
    () => crossoverCurve(params, workloadIdForKind(optKind), bestDpu.dpus, CROSS_N),
    [params, optKind, bestDpu.dpus]
  )
  const crossover = firstCrossover(crossPoints)
  const optTasks = useMemo(
    () =>
      generateTasks(params, {
        count: 32,
        totalElements,
        seed: 5,
        only: optKind,
      }),
    [params, optKind, totalElements]
  )
  const optCompare = useMemo(
    () => comparePolicies(optTasks, params, bestDpu.dpus),
    [optTasks, params, bestDpu.dpus]
  )

  return (
    <div className="page lab-page">
      <div className="deep-hero">
        <div>
          <h2>Algorithm Lab · real workloads &amp; optimisation</h2>
          <p className="fineprint">
            Run the actual DPU kernels through the bridge (measured cycle counts from the UPMEM
            SDK functional simulator), then compare sequential and parallel composition, scaling
            and optimal partitioning. Measured and modelled values are labelled separately.
          </p>
        </div>
        <div className="facts">
          <span className="chip pim">measured: DPU cycles</span>
          <span className="chip warning">modelled: parallel composition</span>
          <span className="chip info">{selected.length} kernels selected</span>
        </div>
      </div>

      <div className="tab-row lab-tabs">
        {SUBS.map((s) => (
          <button
            key={s.id}
            className={`tab ${sub === s.id ? 'active' : ''}`}
            onClick={() => setSub(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sub === 'workloads' && (
        <>
          <section className="panel">
            <div className="sched-controls">
              <label>
                DPUs per run
                <select value={dpus} onChange={(e) => setDpus(Number(e.target.value))}>
                  {DPU_CHOICES.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn primary" onClick={runSelected} disabled={batchRunning || !!running}>
                ▶ Run selected sequentially
              </button>
              <button className="btn" onClick={stopBatch} disabled={!batchRunning}>
                Stop
              </button>
              <span className="live-sep" />
              <button className="btn" onClick={() => setSelected(KERNEL_CARDS.map((k) => k.id))}>
                Select all
              </button>
              <button className="btn" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
            <p className="fineprint">
              The bridge spawns <code>make</code> and the host binary for each selected kernel,
              one after another, and streams the measured events. The parallel comparison below is
              a <strong>model</strong>: it uses the scheduler to place the same work across DPUs.
            </p>
            {error && (
              <div className="live-error">
                <strong>Run failed.</strong> {error}
              </div>
            )}
            {batchRunning && (
              <p className="fineprint">
                Running {selected.length} kernel(s) on {dpus} DPU(s)… the functional simulator is
                instruction-accurate and can take tens of seconds.
              </p>
            )}
          </section>

          <div className="kernel-grid">
            {KERNEL_CARDS.map((card) => {
              const run = single[card.id]
              const m = measured[card.id]
              return (
                <div className="kernel-card" key={card.id}>
                  <div className="kernel-head">
                    <span className="task-dot" style={{ background: KIND_COLOR[card.kind] }} />
                    <h4>{card.title}</h4>
                    <span className="chip info">{card.id}</span>
                  </div>
                  <p className="fineprint">{card.strategy}</p>
                  <p className="fineprint">
                    <code>{card.source}</code>
                  </p>
                  {m && (
                    <p className="fineprint measured-line">
                      measured anchor: {m.dpus} DPUs · {m.cycles.toLocaleString()} cycles ·{' '}
                      {fmtTime(m.kernelS)}
                    </p>
                  )}
                  {run && (
                    <div className="kernel-run">
                      <RunSummary run={run} />
                    </div>
                  )}
                  <div className="btn-row">
                    <label className="kernel-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(card.id)}
                        onChange={() => toggle(card.id)}
                      />
                      include
                    </label>
                    <button
                      className="btn small"
                      onClick={() => runOne(card.id)}
                      disabled={batchRunning || !!running}
                    >
                      {running === card.id ? 'running…' : 'Run on DPUs'}
                    </button>
                    <button className="btn small" onClick={() => replayDemo(card)}>
                      Replay demo
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <section className="panel">
            <h3>Sequential vs parallel</h3>
            <p className="fineprint">
              Sequential means one kernel after another on the same DPU set. Parallel means the
              scheduler packs the same work into the DPU lanes at the same time. The measured
              column is the real DPU simulator; the parallel column is modelled.
            </p>
            <div className="sched-kpis">
              <div className="kpi">
                <strong>{fmtTime(sequentialModelS)}</strong>
                <span>modelled sequential</span>
              </div>
              <div className="kpi">
                <strong>{fmtTime(parallelModelS)}</strong>
                <span>modelled parallel (adaptive)</span>
              </div>
              <div className="kpi">
                <strong>
                  {fmtSpeedup(sequentialModelS > 0 ? sequentialModelS / parallelModelS : 0)}
                </strong>
                <span>parallel gain</span>
              </div>
              <div className="kpi">
                <strong>
                  {measuredBatch.length
                    ? fmtTime(measuredSequentialKernelS)
                    : '—'}
                </strong>
                <span>measured sequential kernel time</span>
              </div>
              <div className="kpi">
                <strong>{pct(parallel.byPolicy.adaptive.schedule.pimUtilization)}</strong>
                <span>modelled PIM utilisation</span>
              </div>
            </div>

            <div className="table-scroll">
              <table className="results-table wide">
                <thead>
                  <tr>
                    <th>Kernel</th>
                    <th>Kind</th>
                    <th>Selected</th>
                    <th>Measured anchor</th>
                    <th>Modelled PIM time</th>
                    <th>Modelled placement</th>
                  </tr>
                </thead>
                <tbody>
                  {KERNEL_CARDS.map((card) => {
                    const m = measured[card.id]
                    const model = simulate(
                      (() => {
                        const p = JSON.parse(JSON.stringify(params)) as typeof params
                        p.pim.banks = dpus
                        p.pim.unitsPerBank = 1
                        return p
                      })(),
                      workloadById(card.workloadId),
                      totalElements
                    )
                    return (
                      <tr key={card.id} className={selected.includes(card.id) ? '' : 'muted-row'}>
                        <td>{card.title}</td>
                        <td>{KIND_INFO[card.kind].label}</td>
                        <td>{selected.includes(card.id) ? 'yes' : '—'}</td>
                        <td>
                          {m ? `${fmtTime(m.kernelS)} @ ${m.dpus} DPUs` : 'not saved'}
                        </td>
                        <td>{fmtTime(model.pim.time)}</td>
                        <td>
                          {model.pim.bound} · {fmtSpeedup(model.speedup)} vs CPU
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {measuredBatch.length > 0 && (
              <>
                <h4>Measured sequential batch</h4>
                <div className="table-scroll">
                  <table className="results-table wide">
                    <thead>
                      <tr>
                        <th>Kernel</th>
                        <th>DPUs</th>
                        <th>Cycles</th>
                        <th>Kernel time</th>
                        <th>Host phases</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {measuredBatch.map((r) => (
                        <tr key={r.kernel}>
                          <td>{r.kernel}</td>
                          <td>{r.state.meta?.dpus}</td>
                          <td>{r.state.dpu?.cycles.toLocaleString()}</td>
                          <td>
                            {fmtTime(
                              (r.state.dpu?.cycles ?? 0) / (DPU_CLOCK_GHZ * 1e9)
                            )}
                          </td>
                          <td>{r.state.totalMs.toFixed(1)} ms</td>
                          <td>{r.state.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="fineprint">
                  Sum of measured kernel times = {fmtTime(measuredSequentialKernelS)}. The modelled
                  parallel plan is {fmtTime(parallelModelS)}. Different quantities (kernel-only vs
                  full modelled path), so read the gain as an indicator, not a hardware speedup.
                </p>
              </>
            )}
          </section>
        </>
      )}

      {sub === 'scaling' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Scaling with DPU count</h3>
              <p className="fineprint">
                Model throughput at a fixed 1M elements per DPU (total grows with the DPU count,
                matching the kernels’ <code>N_ELEMENTS</code>). The diamond is the saved measured
                kernel at its DPU count; kernel throughput excludes copy and merge.
              </p>
            </div>
            <label className="inline-select">
              Workload
              <select value={scaleKernel} onChange={(e) => setScaleKernel(e.target.value)}>
                {KERNEL_CARDS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="chart-panel">
            <LineChart
              series={[
                {
                  points: scaleSeries,
                  color: KIND_COLOR[scaleCard.kind],
                  label: `${scaleCard.id} model`,
                },
              ]}
              markers={
                measuredThroughput && measuredAnchor
                  ? [
                      {
                        x: measuredAnchor.dpus,
                        y: measuredThroughput,
                        color: '#ff9f43',
                        label: 'measured',
                        shape: 'diamond' as const,
                      },
                    ]
                  : []
              }
              logX={false}
              logY={false}
              xLabel="DPUs"
              yLabel="kernel throughput (ops/s)"
            />
            <p className="fineprint">
              Model: {scaleCard.title} · {fmtCount(scaleRows[scaleRows.length - 1].result.pim.throughput)}{' '}
              ops/s at {DPU_CHOICES[DPU_CHOICES.length - 1]} DPUs.
              {measuredThroughput && measuredAnchor
                ? ` Measured: ${fmtCount(measuredThroughput)} ops/s at ${measuredAnchor.dpus} DPUs.`
                : ' No measured anchor for this kernel yet.'}
            </p>
          </div>

          <div className="table-scroll">
            <table className="results-table wide">
              <thead>
                <tr>
                  <th>DPUs</th>
                  <th>Elements</th>
                  <th>PIM kernel</th>
                  <th>PIM total</th>
                  <th>Throughput</th>
                  <th>Speedup vs CPU</th>
                  <th>Bound</th>
                </tr>
              </thead>
              <tbody>
                {scaleRows.map((r) => (
                  <tr key={r.dpus}>
                    <td>{r.dpus}</td>
                    <td>{(r.dpus * 1_048_576).toLocaleString()}</td>
                    <td>{fmtTime(r.result.pim.kernel)}</td>
                    <td>{fmtTime(r.result.pim.time)}</td>
                    <td>{fmtCount(r.result.pim.throughput)} ops/s</td>
                    <td>{fmtSpeedup(r.result.speedup)}</td>
                    <td>{r.result.pim.bound}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fineprint">
            The flattening is the model’s communication term: reductions and histograms merge one
            partial per unit through the host, so adding DPUs eventually stops paying off.
          </p>
        </section>
      )}

      {sub === 'optimization' && (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>Adaptive workload partitioning</h3>
                <p className="fineprint">
                  For a homogeneous {KIND_INFO[optKind].label.toLowerCase()} workload, sweep DPU
                  count and chunk size, then read the minimum. The chunk-size sweep also shows the
                  dispatch/merge overhead of making tasks too small.
                </p>
              </div>
              <label className="inline-select">
                Workload
                <select
                  value={optKind}
                  onChange={(e) => setOptKind(e.target.value as TaskKind)}
                >
                  {KIND_CHOICES.map((k) => (
                    <option key={k} value={k}>
                      {k} — {KIND_INFO[k].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="sched-kpis">
              <div className="kpi">
                <strong>{bestDpu.dpus}</strong>
                <span>optimal DPUs</span>
              </div>
              <div className="kpi">
                <strong>{fmtTime(bestDpu.makespanS)}</strong>
                <span>makespan at optimum</span>
              </div>
              <div className="kpi">
                <strong>{fmtSpeedup(bestDpu.speedupVsCpu)}</strong>
                <span>vs CPU sequential</span>
              </div>
              <div className="kpi">
                <strong>{bestChunk.chunks}</strong>
                <span>optimal chunks</span>
              </div>
              <div className="kpi">
                <strong>{bestChunk.elementsPerTask.toLocaleString()}</strong>
                <span>elements per task</span>
              </div>
              <div className="kpi">
                <strong>{crossover ? fmtCount(crossover.n) : '—'}</strong>
                <span>PIM crossover elements</span>
              </div>
            </div>

            <div className="opt-grid">
              <div>
                <h4>DPU count sweep</h4>
                <table className="results-table wide">
                  <thead>
                    <tr>
                      <th>DPUs</th>
                      <th>Makespan</th>
                      <th>Speedup</th>
                      <th>PIM util.</th>
                      <th>CPU / PIM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dpuRows.map((r) => (
                      <tr key={r.dpus} className={r.dpus === bestDpu.dpus ? 'win-row' : ''}>
                        <td>{r.dpus}</td>
                        <td>{fmtTime(r.makespanS)}</td>
                        <td>{fmtSpeedup(r.speedupVsCpu)}</td>
                        <td>{pct(r.pimUtilization)}</td>
                        <td>
                          {r.cpuTasks} / {r.pimTasks}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h4>Chunk-size sweep at {bestDpu.dpus} DPUs</h4>
                <table className="results-table wide">
                  <thead>
                    <tr>
                      <th>Chunks</th>
                      <th>Elements/task</th>
                      <th>Makespan</th>
                      <th>Speedup</th>
                      <th>PIM util.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chunkRows.map((r) => (
                      <tr key={r.chunks} className={r.chunks === bestChunk.chunks ? 'win-row' : ''}>
                        <td>{r.chunks}</td>
                        <td>{r.elementsPerTask.toLocaleString()}</td>
                        <td>{fmtTime(r.makespanS)}</td>
                        <td>{fmtSpeedup(r.speedupVsCpu)}</td>
                        <td>{pct(r.pimUtilization)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="panel">
            <h3>CPU–PIM crossover</h3>
            <p className="fineprint">
              Analytical model at {bestDpu.dpus} DPUs. Crossover is the first element count where
              PIM overtakes the CPU. With resident data the curve starts above 1; with cold data
              the copy-in term moves the crossover to the right.
            </p>
            <div className="chart-panel">
              <LineChart
                series={[
                  {
                    points: crossPoints.map((p) => ({ x: p.n, y: p.speedup })),
                    color: '#4f8cff',
                    label: 'PIM speedup',
                  },
                  {
                    points: [
                      { x: crossPoints[0].n, y: 1 },
                      { x: crossPoints[crossPoints.length - 1].n, y: 1 },
                    ],
                    color: '#8b91ad',
                    label: 'break-even',
                    dashed: true,
                  },
                ]}
                markers={
                  crossover
                    ? [
                        {
                          x: crossover.n,
                          y: crossover.speedup,
                          color: '#3ddc97',
                          label: 'crossover',
                          shape: 'diamond' as const,
                        },
                      ]
                    : []
                }
                logX
                logY={false}
                xLabel="total elements"
                yLabel="speedup (CPU / PIM)"
              />
            </div>
            <table className="results-table wide">
              <thead>
                <tr>
                  <th>Elements</th>
                  <th>CPU time</th>
                  <th>PIM time</th>
                  <th>Speedup</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {crossPoints.map((p) => (
                  <tr key={p.n}>
                    <td>{p.n.toLocaleString()}</td>
                    <td>{fmtTime(p.cpuTimeS)}</td>
                    <td>{fmtTime(p.pimTimeS)}</td>
                    <td>{fmtSpeedup(p.speedup)}</td>
                    <td>
                      {p.speedup > 1 ? (
                        <span className="chip pim">PIM</span>
                      ) : (
                        <span className="chip cpu">CPU</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h3>Strategy comparison at the optimum</h3>
            <p className="fineprint">
              {optKind} · {totalElements.toLocaleString()} elements · {bestDpu.dpus} DPUs ·{' '}
              {bestChunk.chunks} chunks. Same task set, five placement strategies.
            </p>
            <div className="table-scroll">
              <table className="results-table wide">
                <thead>
                  <tr>
                    <th>Approach</th>
                    <th>Makespan</th>
                    <th>Speedup</th>
                    <th>PIM util.</th>
                    <th>CPU / PIM tasks</th>
                    <th>Bank conflicts</th>
                  </tr>
                </thead>
                <tbody>
                  {optCompare.results.map((r) => (
                    <tr key={r.policy} className={r.policy === optCompare.bestPolicy ? 'win-row' : ''}>
                      <td>{r.label}</td>
                      <td>{fmtTime(r.schedule.makespanS)}</td>
                      <td>{fmtSpeedup(r.speedup)}</td>
                      <td>{pct(r.schedule.pimUtilization)}</td>
                      <td>
                        {r.schedule.cpuTasks} / {r.schedule.pimTasks}
                      </td>
                      <td>{r.memory.conflicts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="callout">
              <strong>Partitioning result.</strong> {optKind} wants {bestDpu.dpus} DPU
              {bestDpu.dpus === 1 ? '' : 's'} and {bestChunk.chunks} chunks (
              {bestChunk.elementsPerTask.toLocaleString()} elements per task). Beyond that, extra
              DPUs sit idle or the per-task dispatch/merge overhead dominates.
            </div>
          </section>
        </>
      )}
    </div>
  )
}
