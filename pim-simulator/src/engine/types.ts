// Engine types (Appendix D of the project plan)

export interface CPUParams {
  freqGHz: number
  cores: number
  opsPerCycle: number
  memBWGBs: number
  memLatencyNs: number
  mlp: number
}

export interface PIMParams {
  banks: number
  unitsPerBank: number
  freqGHz: number
  opsPerCycle: number
  bankBWGBs: number
  copyBWGBs: number
  mulCost: number
  launchUs: number
  syncUs: number
}

export interface EnergyParams {
  offchipPJperB: number
  inbankPJperB: number
  cpuPJperOp: number
  pimPJperOp: number
  cpuStaticW: number
  cpuIdleW: number
  pimUnitW: number
}

export interface Params {
  preset: 'mockup' | 'upmem' | 'hbmpim'
  cpu: CPUParams
  pim: PIMParams
  energy: EnergyParams
  dataResident: boolean
  resultNeededOnHost: boolean
}

/** Totals a workload needs, all in bytes / operations / accesses given n elements and P units. */
export interface WorkTotals {
  readBytes: number
  writtenBytes: number
  inputBytes: number
  outputBytes: number
  ops: number
  mulOps: number
  randomAccesses: number
  partialBytesPerUnit: number
  mergeOpsPerUnit: number
  syncs: number
}

export interface Workload {
  id: string
  name: string
  short: string
  description: string
  /** true if results must be copied back to the host for the workload to be useful */
  computeTotals: (n: number, P: number) => WorkTotals
  resultOnPIMOnly?: boolean
  imbalance: number
}

export type PhaseKind = 'copyIn' | 'kernel' | 'merge' | 'copyOut' | 'stream' | 'overlap'

export type Phase = { name: string; kind: PhaseKind; seconds: number }

export type EnergyParts = { movement: number; inBank: number; compute: number; static: number }

export type CPUBound = 'memory' | 'compute'
export type PIMBound = 'copy' | 'bank' | 'compute' | 'communication' | 'overhead'

export interface Result {
  n: number
  workload: string
  preset: Params['preset']
  cpu: {
    time: number
    memTime: number
    computeTime: number
    bytes: number
    accesses: number
    energy: EnergyParts
    throughput: number
    bound: CPUBound
  }
  pim: {
    time: number
    copyIn: number
    kernel: number
    bankTime: number
    computeTime: number
    merge: number
    copyOut: number
    overhead: number
    bytesOffchip: number
    accesses: number
    energy: EnergyParts
    throughput: number
    bound: PIMBound
  }
  speedup: number
  energySaving: number
  arithmeticIntensity: number
  breakEvenRuns: number | null
  timeline: { cpu: Phase[]; pim: Phase[] }
  units: number
  kernelBytes: number
}

export interface BankUtil {
  cpu: { index: number; busyPct: number }[]
  pim: { index: number; busyPct: number }[]
}
