import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/hooks'
import {
  BRIDGE_URL,
  DEMO_RUNS,
  fetchSavedRuns,
  loadRun,
  useLiveRun,
  type PhaseEvent,
} from '../state/live'
import { calibratedParams, predictRun } from '../engine/calibration'
import { fmtBytes, fmtSpeedup, fmtTime } from '../engine/format'
import { workloadById } from '../engine/workloads'

/**
 * Live DPU page: drive the real UPMEM kernels from the dashboard through the
 * SSE bridge, or replay a saved run when no bridge is running.
 */

const KERNELS = ['VA', 'GEMV', 'RED']
const DPU_CHOICES = [1, 2, 4, 8, 16]

const PHASE_ORDER: Record<string, number> = {
  alloc_load: 0,
  copy_in: 1,
  launch: 2,
  copy_out: 3,
  merge: 4,
}

const PHASE_COLOR: Record<string, string> = {
  alloc_load: 'var(--muted)',
  copy_in: 'var(--copy)',
  launch: 'var(--merge)',
  copy_out: 'var(--cout)',
  merge: 'var(--warn)',
}

export function Live() {  const { state } = useStore()
  const live = useLiveRun()
  const run = live.state

  const [kernel, setKernel] = useState('VA')
  const [dpus, setDpus] = useState(4)
  const [saved, setSaved] = useState<string[]>([])
  const [savedName, setSavedName] = useState(DEMO_RUNS[0].name)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refreshSaved = () => {
    fetchSavedRuns().then((runs) => {
      setSaved(runs)
    })
  }

  // No probe on mount: with the bridge stopped, a fetch would only log a
  // connection error. The bundled demos already work; ↻ connects on demand.
  useEffect(() => {
    if (run.done) refreshSaved()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.done])

  const phases = useMemo(
    () =>
      [...run.phases].sort(
        (a, b) => (PHASE_ORDER[a.name] ?? 9) - (PHASE_ORDER[b.name] ?? 9)
      ),
    [run.phases]
  )

  const maxPhase = Math.max(1, ...phases.map((p) => p.ms))
  const predicted = useMemo(() => {
    if (!run.meta || !run.dpu) return null
    return predictRun(
      calibratedParams(state.params),
      run.meta.kernel,
      run.meta.dpus,
      run.meta.n,
      run.dpu.cycles
    )
  }, [run.meta, run.dpu, state.params])

  const replaySaved = async () => {
    if (!savedName) return
    const text = await loadRun(savedName)
    if (text) live.replay(text, savedName)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    live.replay(await file.text(), file.name)
  }

  return (
    <div className="page live-page">
      <div className="deep-hero">
        <div>
          <h2>Live DPU run &amp; replay</h2>
          <p className="fineprint">
            The bridge spawns <code>make</code> + the host binary in the kernel directory, forwards
            each JSON event the host writes on stderr over SSE, and saves the stream to
            <code> pim-kernels/runs/</code>. The run executes the real UPMEM DPU ISA in the SDK
            functional simulator; host wall time is simulation overhead, not silicon timing.
          </p>
        </div>
        <div className="facts">
          <span className={`chip ${run.source === 'live' ? 'sel' : 'info'}`}>source: {run.source}</span>
          <span className={`chip ${run.running ? 'warning' : 'info'}`}>
            {run.running ? 'running…' : 'idle'}
          </span>
          <span className="chip info">bridge: {BRIDGE_URL.replace(/^https?:\/\//, '')}</span>
        </div>
      </div>

      <section className="panel">
        <div className="live-controls">
          <label>
            Kernel
            <select value={kernel} onChange={(e) => setKernel(e.target.value)}>
              {KERNELS.map((k) => (
                <option key={k} value={k}>
                  {k} — {workloadById(k).short}
                </option>
              ))}
            </select>
          </label>
          <label>
            DPUs
            <select value={dpus} onChange={(e) => setDpus(Number(e.target.value))}>
              {DPU_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={() => live.start(kernel, dpus)} disabled={run.running}>
            ▶ Build &amp; run on DPUs
          </button>
          <button className="btn" onClick={live.stop} disabled={!run.running}>
            Stop
          </button>
          <button className="btn" onClick={live.clear}>
            Clear
          </button>
          <span className="live-sep" />
          <label>
            Replay run
            <select value={savedName} onChange={(e) => setSavedName(e.target.value)}>
              <optgroup label="Built-in demos">
                {DEMO_RUNS.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Saved runs (bridge)">
                {saved.length === 0 && <option value="">press ↻ to list bridge runs</option>}
                {saved.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <button className="btn" onClick={refreshSaved} title="Ask the bridge for its runs/ folder">
            ↻
          </button>
          <button className="btn" onClick={replaySaved} disabled={!savedName}>
            Load
          </button>
          <span className="live-sep" />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Load .jsonl file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.json,.txt"
            hidden
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>
        <p className="fineprint">
          Start the bridge in another terminal: <code>node bridge/server.mjs</code>. It sources{' '}
          <code>upmem-env.sh</code>, builds the selected kernel with <code>NR_DPUS=</code> and
          streams the events. Replay works with the bridge offline; press <strong>↻</strong> to
          list runs the bridge has saved.
        </p>
        {run.error && (
          <div className="live-error">
            <strong>Bridge unavailable.</strong> {run.error}
          </div>
        )}
      </section>

      {run.meta && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>
                {run.meta.kernel} · {run.meta.dpus} DPUs · {run.meta.tasklets} tasklets
              </h3>
              <p className="fineprint">
                n = {run.meta.n.toLocaleString()} elements · {run.meta.ops.toLocaleString()} ops ·
                {' '}
                {fmtBytes(run.meta.n * 4)} of logical data
              </p>
            </div>
            <div className="live-badges">
              {run.dpu && (
                <div className="live-kpi">
                  <strong>{run.dpu.cycles.toLocaleString()}</strong>
                  <span>cycles (max tasklet)</span>
                </div>
              )}
              <div className="live-kpi">
                <strong>{run.totalMs.toFixed(1)} ms</strong>
                <span>host-measured phases</span>
              </div>
            </div>
          </div>

          <h4>Phase timeline</h4>
          <div className="phase-timeline">
            {phases.map((p) => (
              <div
                key={p.name}
                className="phase-seg"
                style={{
                  width: `${(p.ms / maxPhase) * 100}%`,
                  background: PHASE_COLOR[p.name] ?? 'var(--accent)',
                }}
                title={`${p.name}: ${p.ms.toFixed(3)} ms`}
              />
            ))}
          </div>
          <table className="results-table wide">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Time</th>
                <th>Bytes</th>
                <th>Share of host time</th>
              </tr>
            </thead>
            <tbody>
              {phases.map((p: PhaseEvent) => (
                <tr key={p.name}>
                  <td>
                    <span className="phase-dot" style={{ background: PHASE_COLOR[p.name] ?? 'var(--accent)' }} />
                    {p.name}
                  </td>
                  <td>{p.ms.toFixed(3)} ms</td>
                  <td>{p.bytes ? fmtBytes(p.bytes) : '—'}</td>
                  <td>{run.totalMs > 0 ? ((p.ms / run.totalMs) * 100).toFixed(1) : '0'}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fineprint">
            <code>launch</code> includes the functional simulator executing the kernel
            instruction-by-instruction, which is why it dwarfs the data phases. The calibrated
            model therefore uses cycles, not wall-clock launch time.
          </p>
        </section>
      )}

      {predicted && run.meta && run.dpu && (
        <section className="panel">
          <h3>Measured vs analytical model</h3>
          <p className="fineprint">
            Model re-run at the measured configuration: P = {run.meta.dpus}, n ={' '}
            {run.meta.n.toLocaleString()}, calibrated UPMEM parameters. Kernel time is compared —
            copy and merge phases are host-side and not part of the DPU cycle counter.
          </p>
          <table className="results-table wide">
            <thead>
              <tr>
                <th>Quantity</th>
                <th>Measured (DPU sim)</th>
                <th>Analytical model</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Kernel time</td>
                <td>{fmtTime(predicted.measuredKernelS)}</td>
                <td>{fmtTime(predicted.predictedKernelS)}</td>
                <td
                  className={
                    predicted.errorPct !== null && Math.abs(predicted.errorPct) <= 25 ? 'win' : 'lose'
                  }
                >
                  {predicted.errorPct === null
                    ? '—'
                    : `${predicted.errorPct > 0 ? '+' : ''}${predicted.errorPct.toFixed(0)}%`}
                </td>
              </tr>
              <tr>
                <td>Speedup vs this CPU model</td>
                <td>—</td>
                <td>{fmtSpeedup(predicted.result.speedup)}</td>
                <td>—</td>
              </tr>
              <tr>
                <td>Model T_PIM (full path)</td>
                <td>—</td>
                <td>{fmtTime(predicted.result.pim.time)}</td>
                <td>—</td>
              </tr>
              <tr>
                <td>Model bound</td>
                <td>DPU kernel</td>
                <td>{predicted.result.pim.bound}</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {run.events.length > 0 && (
        <section className="panel">
          <h3>Raw event stream</h3>
          <p className="fineprint">
            Exactly what the host emitted, one JSON object per line. The bridge saves this as a
            replayable run file.
          </p>
          <pre className="raw-events">{run.events.map((e) => JSON.stringify(e)).join('\n')}</pre>
        </section>
      )}

      {run.events.length === 0 && !run.error && (
        <section className="panel empty-live">
          <h3>No run loaded</h3>
          <p>
            Pick a kernel and press <strong>Build &amp; run</strong> to execute it on the DPUs, or
            load a saved stream. The three demo runs (VA, GEMV, RED at 4 DPUs) are bundled in{' '}
            <code>public/runs/</code>, so replay works even with the bridge offline.
          </p>
          <p className="fineprint">
            Live runs are also written to <code>pim-kernels/runs/</code> by the bridge; press{' '}
            <strong>↻</strong> to list them.
          </p>
        </section>
      )}
    </div>
  )
}
