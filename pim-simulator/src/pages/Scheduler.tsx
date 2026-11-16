import { useMemo, useState } from 'react'
import { useStore } from '../state/hooks'
import {
  generateTasks,
  KIND_COLOR,
  KIND_INFO,
  type Task,
  type TaskKind,
} from '../engine/tasks'
import { POLICIES, policyInfo, type PolicyId } from '../engine/scheduler'
import { comparePolicies } from '../engine/benchmark'
import {
  ALLOC_POLICIES,
  compareAllocators,
  type AllocPolicy,
} from '../engine/memory'
import { fmtBytes, fmtEnergy, fmtSpeedup, fmtTime } from '../engine/format'

/**
 * Scheduler workspace.
 *
 * Two upgrades live here:
 *   1. intelligent CPU/PIM task scheduling (Tasks / Timeline / Compare)
 *   3. dynamic load balancing (Load)
 *   2. bank allocation and conflict analysis (Memory)
 *
 * All numbers are modelled from the analytical model; see the header badge.
 */

type Sub = 'tasks' | 'timeline' | 'load' | 'memory' | 'compare'

const SUBS: { id: Sub; label: string }[] = [
  { id: 'tasks', label: 'Tasks & decisions' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'load', label: 'Load balancing' },
  { id: 'memory', label: 'Memory & banks' },
  { id: 'compare', label: 'Compare' },
]

const MEM_OPTS = { banksPerDpu: 16, capacityBytes: 64 * 1024 }
const DPU_CHOICES = [1, 2, 4, 8, 16]
const TASK_CHOICES = [8, 16, 32, 64]
const ELEMENT_CHOICES = [0.25, 1, 4]

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

function groupKinds(tasks: Task[]): { kind: TaskKind; count: number }[] {
  const map = new Map<TaskKind, number>()
  for (const t of tasks) map.set(t.kind, (map.get(t.kind) ?? 0) + 1)
  return [...map.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
}

function KindChip({ kind }: { kind: TaskKind | string }) {
  const k = kind as TaskKind
  return (
    <span className="kind-chip" style={{ borderColor: KIND_COLOR[k], color: KIND_COLOR[k] }}>
      <i style={{ background: KIND_COLOR[k] }} />
      {kind}
    </span>
  )
}

function DecisionBadge({ mode, units }: { mode: 'CPU' | 'PIM'; units: number[] }) {
  return mode === 'CPU' ? (
    <span className="chip cpu">CPU</span>
  ) : (
    <span className="chip pim">
      PIM ×{units.length}
    </span>
  )
}

export function Scheduler() {
  const { state } = useStore()
  const [sub, setSub] = useState<Sub>('tasks')
  const [dpus, setDpus] = useState(8)
  const [taskCount, setTaskCount] = useState(32)
  const [elementsM, setElementsM] = useState(1)
  const [seed, setSeed] = useState(42)
  const [resident, setResident] = useState(true)
  const [timelinePolicy, setTimelinePolicy] = useState<PolicyId>('adaptive')
  const [allocPolicy, setAllocPolicy] = useState<AllocPolicy>('bank-aware')
  const [modeFilter, setModeFilter] = useState<'all' | 'CPU' | 'PIM'>('all')

  const params = useMemo(
    () => ({ ...state.params, dataResident: resident }),
    [state.params, resident]
  )
  const totalElements = Math.round(elementsM * 1_000_000)

  const tasks = useMemo(
    () => generateTasks(params, { count: taskCount, totalElements, seed }),
    [params, taskCount, totalElements, seed]
  )

  const comparison = useMemo(
    () => comparePolicies(tasks, params, dpus, { memory: MEM_OPTS }),
    [tasks, params, dpus]
  )

  const adaptive = comparison.byPolicy.adaptive
  const selected = comparison.byPolicy[timelinePolicy]
  const allocReports = useMemo(
    () => compareAllocators(selected.schedule, tasks, params, MEM_OPTS),
    [selected.schedule, tasks, params]
  )
  const memory = allocReports[allocPolicy]

  const cpuTaskList = adaptive.schedule.tasks.filter(
    (t) => adaptive.schedule.decisions[t.id]?.mode === 'CPU'
  )
  const pimTaskList = adaptive.schedule.tasks.filter(
    (t) => adaptive.schedule.decisions[t.id]?.mode === 'PIM'
  )
  const pimUnitCounts = pimTaskList.map(
    (t) => adaptive.schedule.decisions[t.id]?.units.length ?? 1
  )
  const avgUnits =
    pimUnitCounts.length > 0
      ? pimUnitCounts.reduce((a, b) => a + b, 0) / pimUnitCounts.length
      : 0
  const maxLane = comparison.results.reduce(
    (a, r) => Math.max(a, ...r.schedule.lanes.map((l) => l.utilization)),
    0
  )
  const minLane = comparison.results.reduce(
    (a, r) => Math.min(a, ...r.schedule.lanes.map((l) => l.utilization)),
    1
  )

  const shownTasks = adaptive.schedule.tasks.filter((t) => {
    const d = adaptive.schedule.decisions[t.id]
    return modeFilter === 'all' || d?.mode === modeFilter
  })

  const rowLanes = [
    { lane: -1, label: 'CPU', kind: 'CPU' },
    ...Array.from({ length: dpus }, (_, i) => ({ lane: i, label: `DPU ${i}`, kind: 'PIM' })),
  ]

  return (
    <div className="page sched-page">
      <div className="deep-hero">
        <div>
          <h2>Adaptive CPU ⇄ PIM task scheduler</h2>
          <p className="fineprint">
            One task set, five placement strategies. The adaptive scheduler decides <strong>which
            tasks run on the CPU</strong>, <strong>which go to PIM</strong>, and{' '}
            <strong>how many DPUs each PIM task receives</strong>, then picks the least-loaded
            lanes. Every number below is a <strong>model</strong> derived from the same CPU/PIM
            parameters as the Simulator — no UPMEM board is attached.
          </p>
        </div>
        <div className="facts">
          <span className="chip warning">modelled scheduler</span>
          <span className="chip info">{totalElements.toLocaleString()} elements</span>
          <span className="chip info">{dpus} DPUs</span>
          <span className={`chip ${resident ? 'pim' : 'copy'}`}>
            data {resident ? 'resident' : 'cold'}
          </span>
        </div>
      </div>

      <section className="panel">
        <div className="sched-controls">
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
          <label>
            Tasks
            <select value={taskCount} onChange={(e) => setTaskCount(Number(e.target.value))}>
              {TASK_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Total elements
            <select value={elementsM} onChange={(e) => setElementsM(Number(e.target.value))}>
              {ELEMENT_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m}M
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input
              type="number"
              value={seed}
              min={1}
              max={9999}
              onChange={(e) => setSeed(Number(e.target.value) || 1)}
            />
          </label>
          <label className="sched-check">
            <span>Data resident in PIM</span>
            <input
              type="checkbox"
              checked={resident}
              onChange={(e) => setResident(e.target.checked)}
            />
          </label>
          <button className="btn" onClick={() => setSeed((s) => (s % 9999) + 1)}>
            ↻ new task mix
          </button>
        </div>
        <p className="fineprint">
          Deterministic generation: the same seed always produces the same tasks, so the demo is
          reproducible. Resident data is the same assumption as the Simulator’s mockup preset;
          untick it to charge copy-in on every PIM task.
        </p>
      </section>

      <div className="sched-kpis">
        <div className="kpi">
          <strong>{fmtTime(adaptive.schedule.makespanS)}</strong>
          <span>adaptive makespan</span>
        </div>
        <div className="kpi">
          <strong>{fmtSpeedup(comparison.adaptiveSpeedupVsCpu)}</strong>
          <span>vs CPU sequential</span>
        </div>
        <div className="kpi">
          <strong>{pct(comparison.adaptiveGainVsBestBaseline)}</strong>
          <span>better than best baseline</span>
        </div>
        <div className="kpi">
          <strong>
            {adaptive.schedule.cpuTasks} / {adaptive.schedule.pimTasks}
          </strong>
          <span>CPU / PIM tasks</span>
        </div>
        <div className="kpi">
          <strong>{pct(adaptive.schedule.pimUtilization)}</strong>
          <span>PIM utilisation</span>
        </div>
        <div className="kpi">
          <strong>{avgUnits.toFixed(1)}</strong>
          <span>avg DPUs per PIM task</span>
        </div>
      </div>

      <div className="tab-row sched-tabs">
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

      {sub === 'tasks' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Which task went where</h3>
              <p className="fineprint">
                Decisions from the adaptive scheduler. “Why” is the model’s own arithmetic: the
                predicted finish time of the chosen path versus the alternative.
              </p>
            </div>
            <div className="tab-row">
              {(['all', 'CPU', 'PIM'] as const).map((m) => (
                <button
                  key={m}
                  className={`tab ${modeFilter === m ? 'active' : ''}`}
                  onClick={() => setModeFilter(m)}
                >
                  {m === 'all' ? 'All' : m}
                </button>
              ))}
            </div>
          </div>

          <div className="split-cards">
            <div className="split-card cpu">
              <h4>CPU · {cpuTaskList.length} tasks</h4>
              <p>
                {groupKinds(cpuTaskList)
                  .map((g) => `${g.kind} ×${g.count}`)
                  .join(' · ') || 'none'}
              </p>
              <span className="fineprint">
                {fmtBytes(cpuTaskList.reduce((a, t) => a + t.bytes, 0))} touched ·{' '}
                {fmtTime(cpuTaskList.reduce((a, t) => a + t.cpuS, 0))} of CPU work
              </span>
            </div>
            <div className="split-card pim">
              <h4>PIM · {pimTaskList.length} tasks</h4>
              <p>
                {groupKinds(pimTaskList)
                  .map((g) => `${g.kind} ×${g.count}`)
                  .join(' · ') || 'none'}
              </p>
              <span className="fineprint">
                {fmtBytes(pimTaskList.reduce((a, t) => a + t.bytes, 0))} resident ·{' '}
                {avgUnits.toFixed(1)} DPUs per task on average
              </span>
            </div>
          </div>

          <div className="table-scroll">
            <table className="results-table wide sched-task-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Kind</th>
                  <th>Elements</th>
                  <th>Bytes</th>
                  <th>CPU cost</th>
                  <th>PIM ×1</th>
                  <th>Decision</th>
                  <th>DPUs</th>
                  <th>Window</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {shownTasks.map((t) => {
                  const d = adaptive.schedule.decisions[t.id]
                  return (
                    <tr key={t.id}>
                      <td>
                        <span className="task-dot" style={{ background: KIND_COLOR[t.kind] }} />
                        {t.label}
                      </td>
                      <td>{KIND_INFO[t.kind].label}</td>
                      <td>{t.elements.toLocaleString()}</td>
                      <td>{fmtBytes(t.bytes)}</td>
                      <td>{fmtTime(t.cpuS)}</td>
                      <td>{fmtTime(t.pim1S)}</td>
                      <td>
                        <DecisionBadge mode={d?.mode ?? 'CPU'} units={d?.units ?? []} />
                      </td>
                      <td>{d && d.mode === 'PIM' ? d.units.join(', ') : '—'}</td>
                      <td className="nowrap">
                        {fmtTime(d?.startS ?? 0)} → {fmtTime(d?.endS ?? 0)}
                      </td>
                      <td className="why-cell">{d?.reason}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="fineprint">
            CPU cost is the model’s full-machine CPU time for one task. PIM ×1 is the cost on a
            single DPU including the scheduler’s batched dispatch share. Spreading a task over more
            DPUs reduces its kernel time but does not multiply host-link bandwidth.
          </p>
        </section>
      )}

      {sub === 'timeline' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Gantt timeline</h3>
              <p className="fineprint">
                One row per lane. A task that uses several DPUs appears on each of its lanes at
                the same time. Hover a block for task, lane and window.
              </p>
            </div>
            <div className="tab-row">
              {POLICIES.map((p) => (
                <button
                  key={p.id}
                  className={`tab ${timelinePolicy === p.id ? 'active' : ''}`}
                  onClick={() => setTimelinePolicy(p.id)}
                >
                  {p.short}
                </button>
              ))}
            </div>
          </div>

          <div className="gantt">
            <div className="gantt-axis">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <span key={f} style={{ left: `${f * 100}%` }}>
                  {fmtTime(selected.schedule.makespanS * f)}
                </span>
              ))}
            </div>
            {rowLanes.map((row) => {
              const blocks = selected.schedule.intervals.filter((i) => i.lane === row.lane)
              const laneStat =
                row.lane >= 0 ? selected.schedule.lanes[row.lane] : undefined
              return (
                <div className="gantt-row" key={row.lane}>
                  <div className="gantt-label">
                    <span>{row.label}</span>
                    <em>
                      {row.lane >= 0
                        ? pct(laneStat?.utilization ?? 0)
                        : pct(selected.schedule.cpu.utilization)}
                    </em>
                  </div>
                  <div className="gantt-track">
                    {blocks.map((b, i) => {
                      const left = (b.startS / selected.schedule.makespanS) * 100
                      const width = Math.max(
                        0.4,
                        ((b.endS - b.startS) / selected.schedule.makespanS) * 100
                      )
                      return (
                        <div
                          key={`${b.taskId}-${i}`}
                          className="gantt-block"
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            background: KIND_COLOR[b.kind as TaskKind] ?? 'var(--accent)',
                          }}
                          title={`${b.taskKey} · ${b.kind} · ${row.label} · ${fmtTime(
                            b.startS
                          )} → ${fmtTime(b.endS)}${b.units.length > 1 ? ` · ${b.units.length} DPUs` : ''}`}
                        >
                          <span>{b.taskKey}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="gantt-legend">
            {(Object.keys(KIND_COLOR) as TaskKind[]).map((k) => (
              <span key={k}>
                <i style={{ background: KIND_COLOR[k] }} /> {k} — {KIND_INFO[k].label}
              </span>
            ))}
          </div>

          <div className="inline-stats">
            <span>
              Makespan <strong>{fmtTime(selected.schedule.makespanS)}</strong>
            </span>
            <span>
              Speedup <strong>{fmtSpeedup(selected.speedup)}</strong>
            </span>
            <span>
              CPU <strong>{selected.schedule.cpuTasks}</strong> · PIM{' '}
              <strong>{selected.schedule.pimTasks}</strong>
            </span>
            <span>
              Policy: <strong>{policyInfo(selected.policy).label}</strong>
            </span>
          </div>
          <p className="fineprint">{policyInfo(selected.policy).description}</p>
        </section>
      )}

      {sub === 'load' && (
        <section className="panel">
          <h3>Dynamic load balancing</h3>
          <p className="fineprint">
            The adaptive scheduler always places a PIM task on the DPUs that will be free
            earliest (ties go to the lane with fewer tasks). Round Robin is the static baseline:
            it deals tasks cyclically and lets a busy lane stay busy.
          </p>

          <div className="load-compare">
            {(['rr', 'adaptive'] as PolicyId[]).map((id) => {
              const r = comparison.byPolicy[id]
              const util = r.schedule.lanes.map((l) => l.utilization)
              const max = Math.max(...util)
              const min = Math.min(...util)
              const idle = util.filter((u) => u < 0.25).length
              const hot = util.filter((u) => u > 0.9).length
              return (
                <div className="load-card" key={id}>
                  <h4>
                    {policyInfo(id).label}
                    <span>{fmtTime(r.schedule.makespanS)}</span>
                  </h4>
                  <div className="load-bars">
                    {r.schedule.lanes.map((lane) => (
                      <div className="load-row" key={lane.lane}>
                        <span>DPU {lane.lane}</span>
                        <div className="load-track">
                          <div
                            className={`load-fill ${lane.utilization > 0.9 ? 'hot' : ''}`}
                            style={{ width: `${Math.max(0.5, lane.utilization * 100)}%` }}
                          />
                        </div>
                        <em>
                          {pct(lane.utilization)} · {lane.tasks}t
                        </em>
                      </div>
                    ))}
                    <div className="load-row">
                      <span>CPU</span>
                      <div className="load-track">
                        <div
                          className="load-fill cpu"
                          style={{ width: `${Math.max(0.5, r.schedule.cpu.utilization * 100)}%` }}
                        />
                      </div>
                      <em>{pct(r.schedule.cpu.utilization)}</em>
                    </div>
                  </div>
                  <div className="load-summary">
                    <span>max {pct(max)}</span>
                    <span>min {pct(min)}</span>
                    <span>idle lanes {idle}</span>
                    <span className={hot ? 'bad' : 'good'}>overloaded {hot}</span>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="table-scroll">
            <table className="results-table wide">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Makespan</th>
                  <th>Speedup</th>
                  <th>PIM util.</th>
                  <th>Max lane</th>
                  <th>Idle lanes</th>
                  <th>Overloaded</th>
                  <th>CPU tasks</th>
                  <th>PIM tasks</th>
                </tr>
              </thead>
              <tbody>
                {comparison.results.map((r) => {
                  const util = r.schedule.lanes.map((l) => l.utilization)
                  const idle = util.filter((u) => u < 0.25).length
                  const hot = util.filter((u) => u > 0.9).length
                  return (
                    <tr key={r.policy} className={r.policy === 'adaptive' ? 'win-row' : ''}>
                      <td>{r.label}</td>
                      <td>{fmtTime(r.schedule.makespanS)}</td>
                      <td>{fmtSpeedup(r.speedup)}</td>
                      <td>{pct(r.schedule.pimUtilization)}</td>
                      <td>{pct(Math.max(...util))}</td>
                      <td>{idle}</td>
                      <td>{hot}</td>
                      <td>{r.schedule.cpuTasks}</td>
                      <td>{r.schedule.pimTasks}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="callout">
            <strong>Redistribution result.</strong> Adaptive reduces the busiest lane from{' '}
            {pct(
              Math.max(...comparison.byPolicy.rr.schedule.lanes.map((l) => l.utilization))
            )}{' '}
            (Round Robin) to{' '}
            {pct(
              Math.max(...comparison.byPolicy.adaptive.schedule.lanes.map((l) => l.utilization))
            )}{' '}
            and cuts makespan from {fmtTime(comparison.byPolicy.rr.schedule.makespanS)} to{' '}
            {fmtTime(comparison.byPolicy.adaptive.schedule.makespanS)}.
          </div>
        </section>
      )}

      {sub === 'memory' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Bank allocation &amp; conflicts</h3>
              <p className="fineprint">
                Modelled logical MRAM: each DPU has 16 bank parts of 64 KiB. Resident data is
                live from t = 0 until its task ends, so a conflict is a pair of tasks sharing a
                bank over an overlapping lifetime. Schedule:{' '}
                {policyInfo(timelinePolicy).label}.
              </p>
            </div>
            <div className="tab-row">
              {ALLOC_POLICIES.map((p) => (
                <button
                  key={p.id}
                  className={`tab ${allocPolicy === p.id ? 'active' : ''}`}
                  onClick={() => setAllocPolicy(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sched-kpis compact">
            <div className="kpi">
              <strong>{memory.conflicts}</strong>
              <span>bank conflicts</span>
            </div>
            <div className="kpi">
              <strong>{fmtTime(memory.conflictS)}</strong>
              <span>conflict time</span>
            </div>
            <div className="kpi">
              <strong>{pct(memory.peakPct)}</strong>
              <span>peak bank use</span>
            </div>
            <div className="kpi">
              <strong>
                {memory.activeBanks}/{memory.totalBanks}
              </strong>
              <span>active banks</span>
            </div>
            <div className="kpi">
              <strong>{pct(memory.idleBankPct)}</strong>
              <span>idle banks</span>
            </div>
            <div className="kpi">
              <strong>{pct(memory.internalFragPct)}</strong>
              <span>internal frag.</span>
            </div>
          </div>

          <p className="fineprint">
            {ALLOC_POLICIES.find((p) => p.id === allocPolicy)?.description}
          </p>

          <div className="bank-grid">
            {Array.from({ length: memory.dpus }, (_, lane) => (
              <div className="bank-grid-row" key={lane}>
                <span className="bank-grid-label">DPU {lane}</span>
                <div className="bank-grid-cells">
                  {memory.banks
                    .filter((b) => b.lane === lane)
                    .map((b) => (
                      <div
                        key={b.bank}
                        className={`bank-seg ${b.conflicts > 0 ? 'conflict' : ''}`}
                        style={{
                          background: `rgba(79, 140, 255, ${0.12 + b.peakPct * 0.82})`,
                        }}
                        title={`DPU ${lane} · bank ${b.bank} — peak ${fmtBytes(
                          b.peakBytes
                        )} / ${fmtBytes(b.capacityBytes)} (${pct(b.peakPct)}), ${
                          b.blocks.length
                        } block(s), ${b.conflicts} conflict(s)`}
                      >
                        {b.bank}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>

          <div className="table-scroll">
            <table className="results-table wide">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Kind</th>
                  <th>DPU</th>
                  <th>Bank</th>
                  <th>Bytes</th>
                  <th>Window</th>
                </tr>
              </thead>
              <tbody>
                {[...memory.blocks]
                  .sort((a, b) => a.lane - b.lane || a.bank - b.bank || a.startS - b.startS)
                  .slice(0, 40)
                  .map((b, i) => (
                    <tr key={`${b.taskId}-${b.bank}-${i}`}>
                      <td>{b.taskKey}</td>
                      <td>
                        <KindChip kind={b.kind} />
                      </td>
                      <td>{b.lane}</td>
                      <td>{b.bank}</td>
                      <td>{fmtBytes(b.bytes)}</td>
                      <td className="nowrap">
                        {fmtTime(b.startS)} → {fmtTime(b.endS)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {memory.blocks.length > 40 && (
            <p className="fineprint">Showing 40 of {memory.blocks.length} allocations.</p>
          )}

          <div className="callout">
            <strong>Model boundary.</strong> UPMEM’s host API selects DPUs with{' '}
            <code>dpu_alloc</code>; it does not expose physical bank placement. This allocator is
            a logical policy model used to reason about conflicts and fragmentation — it is not
            programming a real bank map.
          </div>

          <table className="results-table wide">
            <thead>
              <tr>
                <th>Allocator</th>
                <th>Conflicts</th>
                <th>Conflict time</th>
                <th>Peak bank</th>
                <th>Active banks</th>
                <th>Idle banks</th>
                <th>Internal frag.</th>
              </tr>
            </thead>
            <tbody>
              {ALLOC_POLICIES.map((p) => {
                const r = allocReports[p.id]
                return (
                  <tr key={p.id} className={p.id === allocPolicy ? 'win-row' : ''}>
                    <td>{p.label}</td>
                    <td>{r.conflicts}</td>
                    <td>{fmtTime(r.conflictS)}</td>
                    <td>{pct(r.peakPct)}</td>
                    <td>
                      {r.activeBanks}/{r.totalBanks}
                    </td>
                    <td>{pct(r.idleBankPct)}</td>
                    <td>{pct(r.internalFragPct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {sub === 'compare' && (
        <section className="panel">
          <h3>
            Five approaches on {totalElements.toLocaleString()} elements / {dpus} DPUs
          </h3>
          <p className="fineprint">
            Same task set, same parameters. “Bank conflicts” uses the bank-aware allocator so the
            column isolates the schedule rather than the allocation policy. Energy is a task-level
            estimate from the energy model.
          </p>

          <div className="table-scroll">
            <table className="results-table wide compare-table">
              <thead>
                <tr>
                  <th>Approach</th>
                  <th>Makespan</th>
                  <th>Speedup</th>
                  <th>CPU tasks</th>
                  <th>PIM tasks</th>
                  <th>PIM util.</th>
                  <th>Max lane</th>
                  <th>Bank conflicts</th>
                  <th>Energy</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {comparison.results.map((r) => {
                  const isBest = r.policy === comparison.bestPolicy
                  const isBaseline = r.policy === 'cpu'
                  return (
                    <tr
                      key={r.policy}
                      className={r.policy === 'adaptive' ? 'win-row' : isBaseline ? 'muted-row' : ''}
                    >
                      <td>
                        <span
                          className="task-dot"
                          style={{ background: policyInfo(r.policy).color }}
                        />
                        {r.label}
                      </td>
                      <td>{fmtTime(r.schedule.makespanS)}</td>
                      <td>{fmtSpeedup(r.speedup)}</td>
                      <td>{r.schedule.cpuTasks}</td>
                      <td>{r.schedule.pimTasks}</td>
                      <td>{pct(r.schedule.pimUtilization)}</td>
                      <td>{pct(Math.max(...r.schedule.lanes.map((l) => l.utilization)))}</td>
                      <td>{r.memory.conflicts}</td>
                      <td>{fmtEnergy(r.energyJ)}</td>
                      <td>
                        {isBest ? (
                          <span className="chip pim">fastest</span>
                        ) : r.policy === 'cpu' ? (
                          <span className="chip info">baseline</span>
                        ) : (
                          <span className="chip info">
                            {(r.schedule.makespanS / comparison.bestMakespanS).toFixed(2)}× slower
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="callout">
            <strong>Adaptive result.</strong> {fmtTime(comparison.byPolicy.adaptive.schedule.makespanS)}{' '}
            makespan, {fmtSpeedup(comparison.adaptiveSpeedupVsCpu)} over CPU sequential and{' '}
            {comparison.adaptiveGainVsBestBaseline >= 0
              ? `${pct(comparison.adaptiveGainVsBestBaseline)} faster than the best baseline`
              : `${pct(-comparison.adaptiveGainVsBestBaseline)} slower than the best baseline`}.
            The scheduler sent {adaptive.schedule.cpuTasks} of {tasks.length} tasks ({groupKinds(cpuTaskList)
              .map((g) => `${g.kind} ×${g.count}`)
              .join(', ') || 'none'}) to the CPU because the CPU path finishes them sooner,
            and spread the remaining {adaptive.schedule.pimTasks} tasks over{' '}
            {adaptive.schedule.taskUnits} DPU slots.
          </div>

          <div className="compare-bars">
            {comparison.results.map((r) => (
              <div className="hbar-row" key={r.policy}>
                <span className="hbar-label">{policyInfo(r.policy).short}</span>
                <div className="hbar-track">
                  <div
                    className="hbar-fill"
                    style={{
                      width: `${(r.schedule.makespanS / comparison.baselineMakespanS) * 100}%`,
                      background: policyInfo(r.policy).color,
                    }}
                  />
                  <span className="hbar-value">{fmtTime(r.schedule.makespanS)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="fineprint facts-left">
            <span className="chip info">max lane utilisation {pct(maxLane)}</span>
            <span className="chip info">min lane utilisation {pct(minLane)}</span>
            <span className="chip info">{dpus} DPUs · {totalElements.toLocaleString()} elements</span>
            <span className="chip warning">model estimate, not measured</span>
          </div>
        </section>
      )}
    </div>
  )
}
