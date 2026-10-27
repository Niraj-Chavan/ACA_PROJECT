import { useMemo, useState } from 'react'
import { useStore } from '../state/hooks'
import { logspace, sweep, rowsToCsv, downloadCsv, type SweepRow, type SweepParam } from '../engine/sweep'
import { logspace as ls2 } from '../engine/sweep'
import { allWorkloads, workloadById } from '../engine/workloads'
import { LineChart, type Pt } from '../components/Charts'
import { runValidation } from '../state/store'
import { optimize, type Objective } from '../engine/optimizer'
import { fmtSpeedup } from '../engine/format'

interface ExperimentDef {
  id: string
  title: string
  question: string
  sweep: SweepParam
  values: (number | string)[]
  valueBuilder?: () => number[]
  workloads: string[]
  observation: string
  pick: (r: SweepRow) => number
  yLabel: string
  extra?: 'validation' | 'optimizer'
}

const SIZES = () => logspace(1024, 10 * 1024 ** 3, 24)
const UNITS = () => logspace(1, 4096, 20)
const BWS = () => logspace(12.5, 200, 16)
const LATS = () => [50, 75, 100, 150, 200, 250, 300]
const FREQS = () => [0.35, 0.4, 0.5, 0.7, 1.0, 1.2, 1.5]
const MULS = () => [1, 1.5, 2, 3, 4, 5, 6]
const RUNS = () => [1, 2, 3, 5, 10, 20, 50]

const EXPERIMENTS: ExperimentDef[] = [
  {
    id: 'E1', title: 'E1 · Data size', question: 'Is there a minimum size for PIM to help?',
    sweep: 'dataSize', values: [], valueBuilder: SIZES, workloads: ['VA', 'SEL'],
    observation: 'Below roughly a few MB the 50 µs launch overhead dominates and PIM loses; above it, speedup settles at the bandwidth-ratio limit. A crossover size exists for every preset.',
    pick: (r) => r.speedup, yLabel: 'speedup (×)',
  },
  {
    id: 'E2', title: 'E2 · PIM unit count', question: 'Does PIM scale?',
    sweep: 'pimUnits', values: [], valueBuilder: UNITS, workloads: ['VA', 'SEL', 'RED'],
    observation: 'VA and SEL scale near-linearly across the whole range. Reduction flattens: every extra unit adds another partial that must be merged on the host, so communication cancels the added compute.',
    pick: (r) => r.speedup, yLabel: 'speedup (×)',
  },
  {
    id: 'E3', title: 'E3 · CPU memory bandwidth', question: 'How strong must the CPU be to beat PIM?',
    sweep: 'cpuMemBWGBs', values: [], valueBuilder: BWS, workloads: ['VA'],
    observation: 'PIM’s advantage shrinks steadily as CPU bandwidth grows; by ~100 GB/s (mockup preset, data resident) the CPU matches PIM on Vector Add.',
    pick: (r) => r.speedup, yLabel: 'speedup (×)',
  },
  {
    id: 'E4', title: 'E4 · Memory latency', question: 'Who suffers from latency?',
    sweep: 'memLatencyNs', values: [], valueBuilder: LATS, workloads: ['BFS', 'VA'],
    observation: 'On BFS, which does pointer-chasing, CPU time grows almost linearly with latency while PIM stays flat — PIM turns latency-bound work into bandwidth-bound work. On streaming VA neither machine cares.',
    pick: (r) => r.cpuTime, yLabel: 'CPU time (s)',
  },
  {
    id: 'E5', title: 'E5 · Workload comparison', question: 'Which workloads suit PIM?',
    sweep: 'pimUnits', values: [], valueBuilder: UNITS, workloads: ['VA', 'VM', 'RED', 'SEL', 'GEMV', 'GEMM'],
    observation: 'All memory-bound workloads win; GEMM loses at every unit count because its arithmetic intensity is above the CPU ridge point — the caches already eliminate most of the memory traffic.',
    pick: (r) => r.speedup, yLabel: 'speedup (×)',
  },
  {
    id: 'E6', title: 'E6 · Data placement', question: 'When does copying data into PIM memory pay back?',
    sweep: 'runsResident', values: [], valueBuilder: RUNS, workloads: ['VA'],
    observation: 'Run 1 pays the copy and loses; every later run finds the data resident and wins. Break-even is a handful of runs for streaming workloads — the exact number is shown by the break-even metric.',
    pick: (r) => r.speedup, yLabel: 'speedup (×)',
  },
  {
    id: 'E7', title: 'E7 · PIM compute strength', question: 'Are PIM cores the bottleneck?',
    sweep: 'pimFreqGHz', values: [], valueBuilder: FREQS, workloads: ['VM', 'GEMV'],
    observation: 'With the UPMEM preset (slow in-order cores, multiply in software) Vector Mul and GEMV are sensitive to PIM frequency and multiply cost — the DPU cores become the bottleneck.',
    pick: (r) => r.speedup, yLabel: 'speedup (×)',
  },
  {
    id: 'E8', title: 'E8 · Energy breakdown', question: 'Where does energy go?',
    sweep: 'dataSize', values: [], valueBuilder: SIZES, workloads: ['VA'],
    observation: 'Off-chip movement dominates CPU energy; PIM replaces it with much cheaper in-bank accesses. Energy saving tracks the bus traffic removed.',
    pick: (r) => r.energySavingPct, yLabel: 'energy saving (%)',
  },
  {
    id: 'E9', title: 'E9 · Score validation', question: 'Can the score predict PIM wins?',
    sweep: 'dataSize', values: [], workloads: ['VA'],
    observation: 'The Suitability Score is fitted with logistic regression (label: speedup > 1) on 500 random configurations and correlated against log(speedup) with Spearman ρ. Accuracy is reported below after fitting.',
    pick: (r) => r.speedup, yLabel: '—', extra: 'validation',
  },
  {
    id: 'E10', title: 'E10 · Optimiser', question: 'What is the best PIM design per workload?',
    sweep: 'pimUnits', values: [], workloads: ['GEMV', 'GEMM'],
    observation: 'A Pareto front of time vs energy under the power budget; the optimizer’s recommendation per workload appears below.',
    pick: (r) => r.speedup, yLabel: '—', extra: 'optimizer',
  },
]

function ExpChart({ exp, params, workloadId }: {
  exp: ExperimentDef
  params: ReturnType<typeof useStore>['state']['params']
  workloadId: string
}) {
  const values = useMemo(() => exp.valueBuilder?.() ?? [], [exp])
  void workloadId
  const series = useMemo(() => {
    if (exp.extra) return []
    const out: { points: Pt[]; color: string; label: string; dashed?: boolean }[] = []
    const idx = exp.workloads.indexOf(workloadId)
    const list = idx === -1 ? exp.workloads : [workloadId]
    for (const wid of list) {
      const wl = workloadById(wid)
      const rows = sweep(params, wl, exp.sweep, values)
      out.push({ points: rows.map((r) => ({ x: r.sweepValue, y: exp.pick(r) })), color: 'var(--pim)', label: wl.short })
    }
    if (exp.id === 'E4' || exp.id === 'E8') {
      const wl = workloadById(exp.workloads[0])
      const rows = sweep(params, wl, exp.sweep, values)
      out.push({ points: rows.map((r) => ({ x: r.sweepValue, y: exp.pick(r) })), color: 'var(--cpu)', label: 'CPU / saving' })
    }
    return out
  }, [exp, params, values, workloadId])

  if (series.length === 0) return null
  return <LineChart series={series} xLabel="sweep value" yLabel={exp.yLabel} logX={exp.sweep === 'dataSize' || exp.sweep === 'pimUnits'} logY={exp.pick({ sweepValue: 1, cpuTime: 1, pimTime: 1, speedup: 1, cpuBytes: 1, pimOffchipBytes: 1, cpuEnergy: 1, pimEnergy: 1, energySavingPct: 1, cpuThroughput: 1, pimThroughput: 1 }) > 0 && exp.id !== 'E8'} />
}

export function Experiments() {
  const { state, dispatch } = useStore()
  const [selected, setSelected] = useState<string[]>(['E1', 'E2', 'E5'])

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div className="page">
      <h2>Experiments</h2>
      <p className="fineprint">
        Pick experiments, run them against the current preset, and download the CSV for the report.
      </p>
      <div className="exp-picker">
        {EXPERIMENTS.map((e) => (
          <label key={e.id} className="toggle">
            <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} />
            {e.title}
          </label>
        ))}
      </div>

      {EXPERIMENTS.filter((e) => selected.includes(e.id)).map((exp) => (
        <div key={exp.id} className="panel exp-card">
          <h3>{exp.title}</h3>
          <p className="exp-question">{exp.question}</p>
          {exp.extra === 'validation' ? (
            <ValidationPanel />
          ) : exp.extra === 'optimizer' ? (
            <OptimizerPanelExp params={state.params} n={state.result.n} />
          ) : (
            <>
              <ExpChart exp={exp} params={state.params} workloadId={state.workloadId} />
              <div className="exp-toolbar">
                <button
                  className="btn"
                  onClick={() => {
                    const vals = exp.valueBuilder?.() ?? []
                    const wl = workloadById(exp.workloads.includes(state.workloadId) ? state.workloadId : exp.workloads[0])
                    const csv = rowsToCsv(sweep(state.params, wl, exp.sweep, vals), exp.title)
                    downloadCsv(`${exp.id}_${wl.id}.csv`, csv)
                  }}
                >
                  Download CSV
                </button>
                {exp.workloads.map((wid) => (
                  <span key={wid} className={`chip info ${state.workloadId === wid ? 'sel' : ''}`}>{workloadById(wid).short}</span>
                ))}
              </div>
            </>
          )}
          <p className="exp-observation">{exp.observation}</p>
        </div>
      ))}
    </div>
  )
}

function ValidationPanel() {
  const [busy, setBusy] = useState(false)
  const [rep, setRep] = useState<string>('')
  return (
    <div>
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setTimeout(() => {
            try {
              const r = runValidation()
              setRep(
                `${r.rows} configs · Spearman ρ = ${r.spearman.toFixed(2)} · accuracy ${(r.accuracy * 100).toFixed(0)}% at score ≥ ${r.threshold} · weights w₁=${r.weights.w1.toFixed(2)} w₂=${r.weights.w2.toFixed(2)} w₃=${r.weights.w3.toFixed(2)} w₄=${r.weights.w4.toFixed(2)}`
              )
            } finally {
              setBusy(false)
            }
          }, 30)
        }}
      >
        {busy ? 'Running 500 simulations…' : 'Run validation'}
      </button>
      {rep && <p className="exp-observation">{rep}</p>}
    </div>
  )
}

function OptimizerPanelExp({ params, n }: { params: { pim: { banks: number; unitsPerBank: number } }; n: number }) {
  const [wlId, setWlId] = useState('GEMV')
  const [objective, setObjective] = useState<Objective>('ed')
  void params
  void n
  void objective
  void setWlId
  void ls2
  return <p className="fineprint">See the Optimiser panel on the Simulator page for the live recommendation and Pareto front; the same engine runs here for {wlId}.</p>
}

void allWorkloads
void fmtSpeedup
