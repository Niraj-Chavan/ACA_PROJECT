import { useMemo, useState } from 'react'
import { useStore } from '../state/hooks'
import { workloadById } from '../engine/workloads'
import { formulaTrace, traceValue, type TraceGroup, type TraceStep } from '../engine/trace'
import {
  CALIBRATION,
  MEASURED_RUNS,
  calibratedParams,
  effectiveCopyGBs,
  predictRun,
} from '../engine/calibration'
import { fmtBytes, fmtSpeedup, fmtTime } from '../engine/format'

/**
 * Deep dive: how the real UPMEM DPU works, the analytical formulas applied
 * to the current configuration, and what was actually measured.
 */

type Filter = 'all' | TraceGroup

const GROUP_CLASS: Record<TraceGroup, string> = {
  CPU: 'cpu',
  PIM: 'pim',
  Verdict: 'verdict',
}

function phaseSeconds(trace: ReturnType<typeof formulaTrace>, group: TraceGroup, step: TraceStep): number {
  if (step.unit !== 's') return 0
  const totalId = group === 'CPU' ? 'cpu-total' : 'pim-total'
  const total = trace.steps.find((s) => s.id === totalId)?.value ?? 0
  return total > 0 ? Math.min(1, step.value / total) : 0
}

export function Deep() {
  const { state, dispatch } = useStore()
  const [filter, setFilter] = useState<Filter>('all')
  const [openNote, setOpenNote] = useState<string | null>(null)

  const n = Math.max(64, Math.round(state.dataBytes / 4))
  const workload = workloadById(state.workloadId)
  const trace = useMemo(() => formulaTrace(state.params, workload, n), [state.params, workload, n])
  const calibrated = useMemo(() => calibratedParams(state.params), [state.params])

  const visible = trace.steps.filter((s) => filter === 'all' || s.group === filter)
  const wins = trace.result.speedup >= 1

  const applyMeasured = () => dispatch({ type: 'patchParams', params: calibrated })

  return (
    <div className="page deep-page">
      <div className="deep-hero">
        <div>
          <h2>PIM internals &amp; formula inspector</h2>
          <p className="fineprint">
            We do not just draw PIM: the kernels in <code>pim-kernels/</code> are compiled by
            <code> dpu-upmem-dpurte-clang</code> to the real UPMEM DPU ISA and executed by the SDK
            runtime. This page shows the hardware those kernels run on, then decomposes the
            analytical model term by term for the current configuration.
          </p>
        </div>
        <div className="facts">
          <span className="chip info">4–16 DPUs</span>
          <span className="chip info">16 tasklets / DPU</span>
          <span className="chip info">64 MiB MRAM / DPU</span>
          <span className="chip info">64 KiB WRAM / DPU</span>
          <span className="chip info">256 B DMA bursts</span>
          <span className="chip info">0.35 GHz · no cache</span>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      <section className="panel">
        <h3>1 · The machine we actually execute on</h3>
        <div className="internals">
          <div className="internals-node host">
            <div className="node-title">Host CPU + DRAM</div>
            <div className="node-sub">Linux process</div>
            <div className="node-body">Allocates buffers, launches the DPU set, reads results</div>
          </div>

          <div className="internals-link">
            <span>copy-in</span>
            <div className="link-rail"><i /></div>
            <span>copy-out</span>
          </div>

          <div className="internals-array">
            <div className="array-label">UPMEM DPU set · one processing unit per memory bank</div>
            <div className="dpu-cards">
              {[0, 1, 2, 3].map((d) => (
                <div className="dpu-card" key={d}>
                  <div className="dpu-head">
                    <span>DPU {d}</span>
                    <span className="dpu-clock">0.35 GHz</span>
                  </div>
                  <div className="dpu-mram">
                    <span>MRAM 64 MiB</span>
                    <div className="bank-strip">
                      {Array.from({ length: 16 }, (_, i) => (
                        <i key={i} className={i === (d % 4) ? 'hot' : ''} />
                      ))}
                    </div>
                    <span className="dpu-note">bank-resident matrix / vector slice</span>
                  </div>
                  <div className="dpu-dma">DMA engine · 256 B aligned bursts</div>
                  <div className="dpu-wram">
                    <span>WRAM 64 KiB</span>
                    <div className="tasklet-grid">
                      {Array.from({ length: 16 }, (_, i) => (
                        <i key={i} title={`tasklet ${i}`} />
                      ))}
                    </div>
                  </div>
                  <div className="dpu-foot">16 hardware tasklets · in-order · perfcounter</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="internals-legend">
          <div>
            <h4>Why this is not a normal accelerator</h4>
            <p>
              Each DPU sits beside a DRAM bank, so the matrix slice never leaves the memory chip.
              The price is a tiny in-order core: 64 KiB of WRAM, no caches, no vector unit, and a
              software multiply. Data must be staged explicitly with <code>mram_read</code> /
              <code> mram_write</code> before the tasklets can touch it.
            </p>
          </div>
          <div>
            <h4>How our kernels use it</h4>
            <ul>
              <li><strong>VA</strong> — each tasklet streams 256 B blocks of A and B, adds, writes C back; no partials, no merge.</li>
              <li><strong>GEMV</strong> — matrix rows stay in MRAM; the full vector x is staged once into shared WRAM behind a hardware barrier; each tasklet owns whole rows.</li>
              <li><strong>RED</strong> — tasklets sum slices, hit <code>barrier_wait</code>, tasklet 0 combines 16 partials; the host then merges one partial per DPU (the model's <code>T_merge</code>).</li>
            </ul>
          </div>
          <div>
            <h4>What the perfcounter measures</h4>
            <p>
              <code>perfcounter_get()</code> returns DPU cycles. We report the maximum across
              tasklets, which is the kernel's critical tasklet. The functional simulator gives
              instruction-accurate counts, not silicon timing — so absolute cycles calibrate
              trends, and published PrIM bandwidths anchor the rest.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>2 · Formula inspector — {workload.name}</h3>
            <p className="fineprint">
              n = {n.toLocaleString()} int32 elements · {fmtBytes(state.dataBytes)} · preset{' '}
              <strong>{state.params.preset}</strong> · {trace.pim.P.toLocaleString()} units
            </p>
          </div>
          <div className={`verdict ${wins ? 'win' : 'lose'}`}>
            {fmtSpeedup(trace.result.speedup)}
            <span>{wins ? 'PIM wins' : 'CPU wins'}</span>
          </div>
        </div>

        <div className="tab-row">
          {(['all', 'CPU', 'PIM', 'Verdict'] as Filter[]).map((f) => (
            <button key={f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All steps' : f}
            </button>
          ))}
          <span className="trace-hint">Click a row for why this term exists. ★ marks the critical path.</span>
        </div>

        <div className="trace-table">
          <div className="trace-row trace-header">
            <div>Term</div>
            <div>Formula and substitution</div>
            <div>Value</div>
            <div className="trace-bar-cell">Share</div>
          </div>
          {visible.map((step) => {
            const share = phaseSeconds(trace, step.group, step)
            const open = openNote === step.id
            return (
              <div
                key={step.id}
                className={`trace-row ${step.dominant ? 'dominant' : ''} ${open ? 'open' : ''}`}
                onClick={() => setOpenNote(open ? null : step.id)}
              >
                <div className="trace-term">
                  <span className={`chip ${GROUP_CLASS[step.group]}`}>{step.group}</span>
                  <strong>
                    {step.dominant ? '★ ' : ''}
                    {step.label}
                  </strong>
                  <div className="trace-badges">
                    {step.peak && <span className="chip sel">max() winner</span>}
                    {step.dominant && <span className="chip info">critical path</span>}
                  </div>
                </div>
                <div className="trace-formula">
                  <code>{step.formula}</code>
                  <div className="trace-sub">{step.substitute}</div>
                  {open && <div className="trace-note">{step.note}</div>}
                </div>
                <div className="trace-value">{traceValue(step)}</div>
                <div className="trace-bar-cell">
                  {step.unit === 's' ? (
                    <div className="share-track">
                      <div
                        className={`share-fill ${GROUP_CLASS[step.group]}`}
                        style={{ width: `${Math.max(1, share * 100)}%` }}
                      />
                    </div>
                  ) : (
                    <span className="fineprint">—</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>3 · Calibration ledger — assumed vs measured</h3>
            <p className="fineprint">
              Green rows are backed by a run on this machine. Everything else carries its source.
              Applying the measured ledger patches the live parameters, so every chart and the
              formula inspector update together.
            </p>
          </div>
          <button className="btn primary" onClick={applyMeasured}>
            Apply measured values
          </button>
        </div>

        <table className="results-table wide calibration-table">
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Model now</th>
              <th>Measured / published</th>
              <th>Source</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {CALIBRATION.map((row) => {
              const assumed = row.assumed(state.params)
              const delta = assumed !== row.measured
              return (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td className={delta ? 'lose' : ''}>
                    {assumed} {row.unit}
                  </td>
                  <td className="win">
                    {row.measured} {row.unit}
                  </td>
                  <td>
                    <span className={`chip ${row.source === 'assumption' ? 'info' : 'sel'}`}>{row.source}</span>
                  </td>
                  <td className="ledger-note">{row.note}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="panel">
        <h3>4 · Real runs feeding this model</h3>
        <p className="fineprint">
          Three kernels, four DPUs, sixteen tasklets per DPU, 4 MiB per array per DPU. Predicted
          kernel time uses the calibrated model at P = DPUs and n = the run's total elements.
        </p>
        <table className="results-table wide">
          <thead>
            <tr>
              <th>Kernel</th>
              <th>DPUs</th>
              <th>n</th>
              <th>Cycles (max tasklet)</th>
              <th>Kernel @ 0.35 GHz</th>
              <th>Copy-in BW</th>
              <th>Model kernel</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {MEASURED_RUNS.map((run) => {
              const p = predictRun(calibrated, run.kernel, run.dpus, run.n, run.cycles)
              return (
                <tr key={run.kernel}>
                  <td>
                    <strong>{run.kernel}</strong>
                  </td>
                  <td>{run.dpus}</td>
                  <td>{run.n.toLocaleString()}</td>
                  <td>{run.cycles.toLocaleString()}</td>
                  <td>{fmtTime(p.measuredKernelS)}</td>
                  <td>{effectiveCopyGBs(run).toFixed(2)} GB/s</td>
                  <td>{fmtTime(p.predictedKernelS)}</td>
                  <td className={p.errorPct !== null && Math.abs(p.errorPct) <= 25 ? 'win' : 'lose'}>
                    {p.errorPct === null ? '—' : `${p.errorPct > 0 ? '+' : ''}${p.errorPct.toFixed(0)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="fineprint">
          The GEMV gap is the multiply model: the simulator's software-multiply sequence is cheaper
          than the 5.7× PrIM reports on silicon, which is exactly the constant the ledger
          back-solves. VA/RED are bandwidth-shaped, and the functional simulator does not model
          bank contention, so their predicted cycles run high.
        </p>
      </section>
    </div>
  )
}
