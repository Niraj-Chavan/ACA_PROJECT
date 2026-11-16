import type { Params } from './types'

/**
 * Task model for the scheduler workspace.
 *
 * A task is one unit of work the scheduler can place either on the CPU or on
 * one or more PIM DPUs. All costs are derived from the same parameters as the
 * analytical model (params.ts) so the scheduler and the Simulator page agree.
 *
 * IMPORTANT: this layer is a MODEL. No UPMEM board is attached. The DPU cost
 * function uses the calibrated in-bank bandwidth, clock, ops/cycle and
 * multiply penalty; the scheduler is a discrete-event/list-scheduling model,
 * not a measurement.
 */

export type TaskKind = 'VA' | 'GEMV' | 'RED' | 'SEARCH' | 'HIST' | 'GEMM'

export interface KindInfo {
  label: string
  /** bytes read per element */
  readPerElem: number
  /** bytes written per element */
  writePerElem: number
  /** arithmetic operations per element */
  opsPerElem: number
  /** multiply operations per element (part of ops) */
  mulPerElem: number
  /** uncached / random accesses per element */
  randomPerElem: number
  /** partial bytes produced per unit (merge traffic) */
  partialBytes: number
  /** merge operations per unit */
  mergeOps: number
  /** barriers inside the kernel */
  syncs: number
  /** relative size multiplier when generating the task mix */
  sizeScale: number
  /** static baseline classifier: is this kind a natural PIM workload? */
  pimFriendly: boolean
  /** one-line description used in the UI */
  note: string
}

export const KIND_INFO: Record<TaskKind, KindInfo> = {
  VA: {
    label: 'Vector add',
    readPerElem: 8,
    writePerElem: 4,
    opsPerElem: 1,
    mulPerElem: 0,
    randomPerElem: 0,
    partialBytes: 0,
    mergeOps: 0,
    syncs: 0,
    sizeScale: 1.1,
    pimFriendly: true,
    note: 'Pure streaming, no merge — the canonical resident-data PIM task.',
  },
  GEMV: {
    label: 'Matrix–vector',
    readPerElem: 4,
    writePerElem: 0.25,
    opsPerElem: 2,
    mulPerElem: 1,
    randomPerElem: 0,
    partialBytes: 0,
    mergeOps: 0,
    syncs: 1,
    sizeScale: 0.8,
    pimFriendly: true,
    note: 'Rows are read once and never reused; low arithmetic intensity.',
  },
  RED: {
    label: 'Reduction',
    readPerElem: 4,
    writePerElem: 0.002,
    opsPerElem: 1,
    mulPerElem: 0,
    randomPerElem: 0,
    partialBytes: 8,
    mergeOps: 1,
    syncs: 1,
    sizeScale: 1.0,
    pimFriendly: true,
    note: 'One partial per unit must merge through the host — scaling flattens.',
  },
  SEARCH: {
    label: 'Parallel search',
    readPerElem: 4,
    writePerElem: 0.01,
    opsPerElem: 2,
    mulPerElem: 0,
    randomPerElem: 0.05,
    partialBytes: 8,
    mergeOps: 1,
    syncs: 0,
    sizeScale: 1.0,
    pimFriendly: true,
    note: 'Scan and count matches; tiny output, so the result stays near the data.',
  },
  HIST: {
    label: 'Histogram',
    readPerElem: 4,
    writePerElem: 0.002,
    opsPerElem: 3,
    mulPerElem: 0,
    randomPerElem: 0.8,
    partialBytes: 1024,
    mergeOps: 256,
    syncs: 1,
    sizeScale: 0.75,
    pimFriendly: false,
    note: 'Scatter into 256 bins; each unit keeps its own partial histogram.',
  },
  GEMM: {
    label: 'Matrix multiply',
    readPerElem: 4,
    writePerElem: 4,
    opsPerElem: 64,
    mulPerElem: 48,
    randomPerElem: 0,
    partialBytes: 0,
    mergeOps: 0,
    syncs: 0,
    sizeScale: 0.55,
    pimFriendly: false,
    note: 'High reuse and multiply-heavy — the CPU counterexample.',
  },
}

/** Colours shared by the Gantt, task table and legend. Hex so both themes work. */
export const KIND_COLOR: Record<TaskKind, string> = {
  VA: '#3ddc97',
  GEMV: '#5ee7c3',
  RED: '#b785ff',
  SEARCH: '#4f8cff',
  HIST: '#f4c95d',
  GEMM: '#ef6f6f',
}

export interface Task {
  /** stable id in generation order */
  id: number
  key: string
  kind: TaskKind
  label: string
  elements: number
  readBytes: number
  writeBytes: number
  /** input + output bytes touched (what a CPU has to stream) */
  bytes: number
  inputBytes: number
  outputBytes: number
  ops: number
  mulOps: number
  randomAccesses: number
  partialBytesPerUnit: number
  mergeOpsPerUnit: number
  syncs: number
  /** CPU time for this task on the whole CPU (seconds) */
  cpuS: number
  /** PIM kernel time on exactly one DPU (seconds, excludes dispatch share) */
  pimUnitS: number
  /** PIM cost including copy and dispatch for one DPU (seconds) */
  pim1S: number
  /** dispatch share per task (seconds) — see pimTaskCost */
  dispatchS: number
  /** energy if executed on the CPU (J) */
  energyCpuJ: number
  /** buffered bytes per DPU for each unit count */
  pimFriendly: boolean
  /** suggested number of DPUs for this task's data (1..4) */
  preferredUnits: number
}

export interface TaskPimCost {
  totalS: number
  kernelS: number
  copyInS: number
  copyOutS: number
  mergeS: number
  syncS: number
  dispatchS: number
  bankS: number
  computeS: number
  mulFactor: number
}

const INBANK_RANDOM_NS = 60
const HOST_MERGE_OPS_PER_S = 2e9
const IMBALANCE = 1.03
/** The 50 µs kernel launch is amortised over a batch of ~25 tasks per DPU. */
export const DISPATCH_SHARE_FACTOR = 1 / 25

/** Small deterministic PRNG (mulberry32) — every demo is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * PIM cost of one task spread across `units` DPUs.
 *
 * The copy-in/copy-out cost is charged once per task: the host link is shared
 * by all DPUs, so splitting a task across more units does not multiply link
 * bandwidth. Kernel work does split by `units`.
 */
export type PimWork = Pick<
  Task,
  | 'bytes'
  | 'ops'
  | 'mulOps'
  | 'randomAccesses'
  | 'inputBytes'
  | 'outputBytes'
  | 'partialBytesPerUnit'
  | 'mergeOpsPerUnit'
  | 'syncs'
>

export function pimTaskCost(task: PimWork, units: number, params: Params): TaskPimCost {
  const u = Math.max(1, Math.floor(units))
  const p = params.pim
  const mulFactor = 1 + (task.ops > 0 ? task.mulOps / task.ops : 0) * (p.mulCost - 1)

  const bankS =
    task.bytes / (u * p.bankBWGBs * 1e9) + (task.randomAccesses / u) * INBANK_RANDOM_NS * 1e-9
  const computeS = (task.ops * mulFactor) / (u * p.freqGHz * 1e9 * p.opsPerCycle)
  const kernelS = Math.max(bankS, computeS) * IMBALANCE

  const copyInS = params.dataResident ? 0 : task.inputBytes / (p.copyBWGBs * 1e9)
  const copyOutS = params.resultNeededOnHost ? task.outputBytes / (p.copyBWGBs * 1e9) : 0
  const mergeS =
    (u * task.partialBytesPerUnit) / (p.copyBWGBs * 1e9) +
    (u * task.mergeOpsPerUnit) / HOST_MERGE_OPS_PER_S
  const syncS = task.syncs * p.syncUs * 1e-6
  const dispatchS = p.launchUs * 1e-6 * DISPATCH_SHARE_FACTOR

  return {
    totalS: copyInS + copyOutS + dispatchS + kernelS + mergeS + syncS,
    kernelS,
    copyInS,
    copyOutS,
    mergeS,
    syncS,
    dispatchS,
    bankS,
    computeS,
    mulFactor,
  }
}

function cpuTaskCost(
  task: Pick<Task, 'bytes' | 'randomAccesses' | 'ops'>,
  params: Params
): number {
  const c = params.cpu
  const bytes = task.bytes + task.randomAccesses * 64
  const memS = bytes / (c.memBWGBs * 1e9)
  const randomS =
    (task.randomAccesses * c.memLatencyNs * 1e-9) / Math.max(1, c.cores * c.mlp)
  const computeS = task.ops / Math.max(1e-9, c.cores * c.freqGHz * 1e9 * c.opsPerCycle)
  return Math.max(memS + randomS, computeS)
}

function cpuTaskEnergy(task: Task, params: Params): number {
  const e = params.energy
  const moveJ = (task.bytes * e.offchipPJperB) / 1e12
  const computeJ = (task.ops * e.cpuPJperOp) / 1e12
  const staticJ = e.cpuStaticW * task.cpuS
  return moveJ + computeJ + staticJ
}

/** A deterministic mix that guarantees every kind appears in small demos. */
const KIND_PATTERN: TaskKind[] = [
  'VA', 'GEMV', 'RED', 'SEARCH', 'VA', 'GEMM',
  'RED', 'VA', 'SEARCH', 'GEMV', 'VA', 'RED',
  'HIST', 'VA', 'GEMV', 'SEARCH', 'RED', 'VA',
  'SEARCH', 'GEMV', 'VA', 'RED', 'GEMM', 'SEARCH',
  'VA', 'GEMV', 'RED', 'SEARCH', 'VA', 'HIST',
  'RED', 'VA',
]

export interface GenerateOptions {
  count?: number
  totalElements?: number
  seed?: number
  /** force every task to one kind (homogeneous optimisation studies) */
  only?: TaskKind
  /** cycle through a subset of kinds instead of the built-in mix */
  kinds?: TaskKind[]
}

/**
 * Generate a deterministic task set.
 *
 * Sizes are randomly weighted but normalised so the task set contains exactly
 * `totalElements` elements. That is the "1 million elements" experiment: the
 * scheduler's job is to place all of it, not to shrink it.
 */
export function generateTasks(params: Params, opts: GenerateOptions = {}): Task[] {
  const count = Math.max(1, Math.floor(opts.count ?? 32))
  const totalElements = Math.max(count * 1024, Math.floor(opts.totalElements ?? 1_000_000))
  const seed = opts.seed ?? 42
  const rng = mulberry32(seed)

  const kinds: TaskKind[] = []
  for (let i = 0; i < count; i++) {
    const fallback = KIND_PATTERN[i % KIND_PATTERN.length]
    kinds.push(opts.only ?? opts.kinds?.[i % Math.max(1, opts.kinds.length)] ?? fallback)
  }

  // deterministic shuffle so FCFS sees a mixed arrival order
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
  }

  const weights = kinds.map((kind) => (0.65 + rng() * 0.7) * KIND_INFO[kind].sizeScale)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const elements = weights.map((w) => Math.max(1024, Math.floor((totalElements * w) / weightSum)))

  // fix rounding drift on the largest task
  let drift = totalElements - elements.reduce((a, b) => a + b, 0)
  let largest = 0
  for (let i = 1; i < elements.length; i++) if (elements[i] > elements[largest]) largest = i
  elements[largest] = Math.max(1024, elements[largest] + drift)

  return kinds.map((kind, i) => {
    const info = KIND_INFO[kind]
    const n = elements[i]
    const readBytes = info.readPerElem * n
    const writeBytes = info.writePerElem * n
    const base = {
      id: i,
      key: `${kind}-${String(i + 1).padStart(2, '0')}`,
      kind,
      label: `${kind}-${String(i + 1).padStart(2, '0')}`,
      elements: n,
      readBytes,
      writeBytes,
      bytes: readBytes + writeBytes,
      inputBytes: readBytes,
      outputBytes: writeBytes,
      ops: info.opsPerElem * n,
      mulOps: info.mulPerElem * n,
      randomAccesses: info.randomPerElem * n,
      partialBytesPerUnit: info.partialBytes,
      mergeOpsPerUnit: info.mergeOps,
      syncs: info.syncs,
      pimFriendly: info.pimFriendly,
    }
    const cpuS = cpuTaskCost(base, params)
    const oneUnit = pimTaskCost(base, 1, params)
    const task = {
      ...base,
      cpuS,
      pimUnitS: oneUnit.kernelS,
      pim1S: oneUnit.totalS,
      dispatchS: oneUnit.dispatchS,
      energyCpuJ: 0,
      preferredUnits: Math.max(1, Math.min(4, Math.ceil(base.bytes / (128 * 1024)))),
    } as Task
    task.energyCpuJ = cpuTaskEnergy(task, params)
    return task
  })
}
