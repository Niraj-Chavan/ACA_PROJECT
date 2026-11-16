import type { Params } from './types'
import { type Task, pimTaskCost } from './tasks'

/**
 * List-scheduling engine for CPU/PIM task placement.
 *
 * Every algorithm produces the same kind of result: a set of lane intervals
 * (CPU lane = -1, DPU lanes = 0..dpus-1), a per-task decision and aggregate
 * metrics. The React page only renders these structures.
 *
 * This is a modelled scheduler: it is not driving real DPU hardware. Costs are
 * derived from the analytical model in `tasks.ts`.
 */

export type PolicyId = 'cpu' | 'static' | 'fcfs' | 'rr' | 'adaptive'

export interface PolicyInfo {
  id: PolicyId
  label: string
  short: string
  color: string
  description: string
}

export const POLICIES: PolicyInfo[] = [
  {
    id: 'cpu',
    label: 'CPU sequential',
    short: 'CPU only',
    color: '#ff9f43',
    description: 'The baseline: every task runs one after another on the CPU, which uses all its cores and full memory bandwidth.',
  },
  {
    id: 'static',
    label: 'Static PIM',
    short: 'Static PIM',
    color: '#3ddc97',
    description: 'Every task is sent to PIM and each DPU receives one contiguous, equal share. No cost model, no rebalancing.',
  },
  {
    id: 'fcfs',
    label: 'FCFS',
    short: 'FCFS',
    color: '#5ee7c3',
    description: 'First come, first served. A static classifier sends streaming tasks to PIM and compute/scatter tasks to the CPU; each PIM task takes the earliest free DPU.',
  },
  {
    id: 'rr',
    label: 'Round Robin',
    short: 'Round Robin',
    color: '#b785ff',
    description: 'Same classifier as FCFS, but PIM tasks are dealt to DPUs cyclically. One large task can stall its lane while others go idle.',
  },
  {
    id: 'adaptive',
    label: 'Adaptive PIM scheduler',
    short: 'Adaptive',
    color: '#4f8cff',
    description: 'Cost-aware and load-aware: longest tasks first, CPU vs PIM chosen by predicted finish time, and each task gets a data-sized number of least-loaded DPUs that minimises its completion time.',
  },
]

export const policyInfo = (id: PolicyId): PolicyInfo =>
  POLICIES.find((p) => p.id === id) ?? POLICIES[0]

export interface Interval {
  taskId: number
  taskKey: string
  kind: string
  /** -1 = CPU, 0..dpus-1 = PIM lane */
  lane: number
  startS: number
  endS: number
  mode: 'CPU' | 'PIM'
  /** all DPUs used by this task (length 1 for CPU) */
  units: number[]
}

export interface TaskDecision {
  taskId: number
  mode: 'CPU' | 'PIM'
  units: number[]
  startS: number
  endS: number
  durationS: number
  reason: string
}

export interface LaneStat {
  lane: number
  busyS: number
  utilization: number
  tasks: number
}

export interface CpuStat {
  busyS: number
  utilization: number
  tasks: number
}

export interface Schedule {
  policy: PolicyId
  tasks: Task[]
  dpus: number
  intervals: Interval[]
  decisions: Record<number, TaskDecision>
  makespanS: number
  cpu: CpuStat
  lanes: LaneStat[]
  pimBusyS: number
  pimUtilization: number
  overallUtilization: number
  cpuTasks: number
  pimTasks: number
  taskUnits: number
  /** filled by comparePolicies */
  speedup: number
}

function emptyTotals(dpus: number) {
  return {
    cpuFree: 0,
    free: Array.from({ length: dpus }, () => 0),
    laneTasks: Array.from({ length: dpus }, () => 0),
    cpuTasks: 0,
    intervals: [] as Interval[],
    decisions: {} as Record<number, TaskDecision>,
  }
}

type Totals = ReturnType<typeof emptyTotals>

function placeCpu(totals: Totals, task: Task, reason: string): TaskDecision {
  const startS = totals.cpuFree
  const endS = startS + task.cpuS
  totals.cpuFree = endS
  totals.cpuTasks += 1
  const decision: TaskDecision = {
    taskId: task.id,
    mode: 'CPU',
    units: [],
    startS,
    endS,
    durationS: task.cpuS,
    reason,
  }
  totals.decisions[task.id] = decision
  totals.intervals.push({
    taskId: task.id,
    taskKey: task.key,
    kind: task.kind,
    lane: -1,
    startS,
    endS,
    mode: 'CPU',
    units: [],
  })
  return decision
}

function placePim(
  totals: Totals,
  task: Task,
  lanes: number[],
  params: Params,
  reason: string
): TaskDecision {
  const units = lanes.length > 0 ? lanes : [0]
  const startS = Math.max(...units.map((l) => totals.free[l]))
  const cost = pimTaskCost(task, units.length, params)
  const endS = startS + cost.totalS
  for (const lane of units) {
    totals.free[lane] = endS
    totals.laneTasks[lane] += 1
    totals.intervals.push({
      taskId: task.id,
      taskKey: task.key,
      kind: task.kind,
      lane,
      startS,
      endS,
      mode: 'PIM',
      units,
    })
  }
  const decision: TaskDecision = {
    taskId: task.id,
    mode: 'PIM',
    units,
    startS,
    endS,
    durationS: cost.totalS,
    reason,
  }
  totals.decisions[task.id] = decision
  return decision
}

/** Least-loaded first, then fewer scheduled tasks, then lane index. */
function pickLanes(free: number[], laneTasks: number[], units: number): number[] {
  return Array.from({ length: free.length }, (_, i) => i)
    .sort((a, b) => free[a] - free[b] || laneTasks[a] - laneTasks[b] || a - b)
    .slice(0, Math.max(1, Math.min(units, free.length)))
}

function floorTask(t: Task): number {
  return Math.max(t.cpuS, t.pim1S)
}

function finalize(
  policy: PolicyId,
  tasks: Task[],
  dpus: number,
  totals: Totals,
  params: Params
): Schedule {
  void params
  const makespanS = Math.max(totals.cpuFree, ...totals.free, 1e-12)
  const laneStats: LaneStat[] = totals.free.map((_, lane) => {
    const busyS = totals.intervals
      .filter((i) => i.lane === lane)
      .reduce((a, i) => a + (i.endS - i.startS), 0)
    return {
      lane,
      busyS,
      utilization: makespanS > 0 ? busyS / makespanS : 0,
      tasks: totals.laneTasks[lane],
    }
  })
  const pimBusyS = laneStats.reduce((a, l) => a + l.busyS, 0)
  const totalCapacity = makespanS * (dpus + 1) // CPU lane counted as one lane
  const overallUtilization =
    totalCapacity > 0 ? (pimBusyS + totals.cpuFree) / totalCapacity : 0
  const pimTasks = Object.values(totals.decisions).filter((d) => d.mode === 'PIM').length
  return {
    policy,
    tasks,
    dpus,
    intervals: totals.intervals,
    decisions: totals.decisions,
    makespanS,
    cpu: {
      busyS: totals.cpuFree,
      utilization: makespanS > 0 ? totals.cpuFree / makespanS : 0,
      tasks: totals.cpuTasks,
    },
    lanes: laneStats,
    pimBusyS,
    pimUtilization: dpus > 0 && makespanS > 0 ? pimBusyS / (dpus * makespanS) : 0,
    overallUtilization,
    cpuTasks: totals.cpuTasks,
    pimTasks,
    taskUnits: Object.values(totals.decisions)
      .filter((d) => d.mode === 'PIM')
      .reduce((a, d) => a + d.units.length, 0),
    speedup: 1,
  }
}

export interface ScheduleOptions {
  /** override the maximum units the adaptive scheduler may use per task */
  maxUnits?: number
}

export function runSchedule(
  tasks: Task[],
  params: Params,
  dpus: number,
  policy: PolicyId,
  opts: ScheduleOptions = {}
): Schedule {
  const lanes = Math.max(1, Math.floor(dpus))
  const totals = emptyTotals(lanes)

  if (policy === 'cpu') {
    for (const task of tasks) placeCpu(totals, task, 'CPU baseline: every task left on the host.')
    return finalize(policy, tasks, lanes, totals, params)
  }

  if (policy === 'static') {
    // contiguous equal share, the "existing implementation" baseline
    const perLane = Math.max(1, Math.ceil(tasks.length / lanes))
    tasks.forEach((task, index) => {
      const lane = Math.min(lanes - 1, Math.floor(index / perLane))
      placePim(
        totals,
        task,
        [lane],
        params,
        `Static PIM: contiguous equal share, lane ${lane} (no cost analysis).`
      )
    })
    return finalize(policy, tasks, lanes, totals, params)
  }

  if (policy === 'fcfs' || policy === 'rr') {
    let rr = 0
    for (const task of tasks) {
      if (!task.pimFriendly) {
        placeCpu(
          totals,
          task,
          `Classifier: ${task.kind} is compute- or scatter-heavy, so FCFS leaves it on the CPU.`
        )
        continue
      }
      const lane =
        policy === 'fcfs' ? pickLanes(totals.free, totals.laneTasks, 1)[0] : rr++ % lanes
      placePim(
        totals,
        task,
        [lane],
        params,
        policy === 'fcfs'
          ? `FCFS: first idle DPU is lane ${lane}; one DPU per task.`
          : `Round Robin: dealt to lane ${lane}; one DPU per task.`
      )
    }
    return finalize(policy, tasks, lanes, totals, params)
  }

  // ---- adaptive -----------------------------------------------------------
  // Longest-processing-time first is the classic makespan heuristic, and it
  // also makes the demo deterministic.
  const ordered = [...tasks].sort((a, b) => {
    const d = floorTask(b) - floorTask(a)
    return d !== 0 ? d : a.id - b.id
  })
  const maxUnits = Math.max(1, Math.min(lanes, opts.maxUnits ?? 8))

  for (const task of ordered) {
    // Data-size cap: splitting a small buffer over every DPU just adds
    // dispatch and merge overhead, so only offer the units this task can fill.
    const cap = Math.max(1, Math.min(maxUnits, task.preferredUnits))
    const unitChoices = [1, 2, 4, 8].filter((u) => u <= cap)
    const cpuEnd = totals.cpuFree + task.cpuS
    let bestEnd = Number.POSITIVE_INFINITY
    let bestUnits: number[] = []
    let bestCost = task.pim1S

    for (const units of unitChoices) {
      const candidate = pickLanes(totals.free, totals.laneTasks, units)
      const start = Math.max(...candidate.map((l) => totals.free[l]))
      const cost = pimTaskCost(task, candidate.length, params)
      const end = start + cost.totalS
      // primary: earliest completion; secondary: fewer DPUs; tertiary: lower lane ids
      const better =
        end < bestEnd - 1e-12 ||
        (Math.abs(end - bestEnd) <= 1e-12 && candidate.length < bestUnits.length)
      if (better) {
        bestEnd = end
        bestUnits = candidate
        bestCost = cost.totalS
      }
    }

    if (cpuEnd <= bestEnd) {
      const delta = bestEnd - cpuEnd
      placeCpu(
        totals,
        task,
        `Adaptive → CPU: best PIM plan is ${delta >= 0 ? delta * 1e3 : 0} ms slower ` +
          `(${bestUnits.length} DPU${bestUnits.length === 1 ? '' : 's'} would finish at ` +
          `${(bestEnd * 1e3).toFixed(2)} ms).`
      )
    } else {
      const delta = cpuEnd - bestEnd
      placePim(
        totals,
        task,
        bestUnits,
        params,
        `Adaptive → PIM: ${bestUnits.length} least-loaded DPU${bestUnits.length === 1 ? '' : 's'} ` +
          `[${bestUnits.join(', ')}] finish ${delta * 1e3 >= 0 ? delta * 1e3 : 0} ms before the CPU ` +
          `(cost ${(bestCost * 1e3).toFixed(2)} ms).`
      )
    }
  }

  return finalize('adaptive', tasks, lanes, totals, params)
}

/** Per-task energy under the scheduler's decision (task-level estimate, J). */
export function taskEnergyJ(task: Task, decision: TaskDecision, params: Params): number {
  const e = params.energy
  if (decision.mode === 'CPU') return task.energyCpuJ
  const units = Math.max(1, decision.units.length)
  const cost = pimTaskCost(task, units, params)
  const copyBytes = params.dataResident ? 0 : task.inputBytes
  const outBytes = params.resultNeededOnHost ? task.outputBytes : 0
  const moveJ = ((copyBytes + outBytes + units * task.partialBytesPerUnit) * e.offchipPJperB) / 1e12
  const inBankJ = (task.bytes * e.inbankPJperB) / 1e12
  const computeJ = (task.ops * cost.mulFactor * e.pimPJperOp) / 1e12
  const staticJ = (e.cpuIdleW + units * e.pimUnitW) * cost.totalS
  return moveJ + inBankJ + computeJ + staticJ
}

export function scheduleEnergyJ(schedule: Schedule, params: Params): number {
  return schedule.tasks.reduce((sum, task) => {
    const decision = schedule.decisions[task.id]
    return decision ? sum + taskEnergyJ(task, decision, params) : sum
  }, 0)
}
