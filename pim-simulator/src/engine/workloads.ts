import type { Workload } from './types'

/**
 * Workload descriptors (Appendix C).
 * Each workload computes total bytes / ops / communication given n elements
 * and P PIM units. For streaming workloads the totals are simply per-element
 * rates times n; GEMV and GEMM derive matrix dimensions from n.
 */

const ELEM = 4 // int32 element size in bytes

function totals(
  readBytes: number,
  writtenBytes: number,
  ops: number,
  mulOps: number,
  randomAccesses: number,
  inputBytes: number,
  outputBytes: number,
  partialBytesPerUnit: number,
  mergeOpsPerUnit: number,
  syncs: number
) {
  return {
    readBytes,
    writtenBytes,
    ops,
    mulOps,
    randomAccesses,
    inputBytes,
    outputBytes,
    partialBytesPerUnit,
    mergeOpsPerUnit,
    syncs,
  }
}

/** Vector Add: C = A + B */
export const vectorAdd: Workload = {
  id: 'VA',
  name: 'Vector Add  C = A + B',
  short: 'Vector Add',
  description: 'Element-wise addition. Pure streaming: reads two int32 arrays, writes one.',
  imbalance: 1.0,
  computeTotals: (n) =>
    totals(8 * n, 4 * n, n, 0, 0, 8 * n, 4 * n, 0, 0, 0),
}

/** Vector Multiply: C = A × B */
export const vectorMul: Workload = {
  id: 'VM',
  name: 'Vector Multiply  C = A × B',
  short: 'Vector Mul',
  description: 'Element-wise multiply. Same traffic as Vector Add, but the op is a multiply — expensive on slow PIM cores.',
  imbalance: 1.0,
  computeTotals: (n) =>
    totals(8 * n, 4 * n, n, n, 0, 8 * n, 4 * n, 0, 0, 0),
}

/** Reduction: sum of an array */
export const reduction: Workload = {
  id: 'RED',
  name: 'Reduction (sum)',
  short: 'Reduction',
  description: 'Sum of an array. Each PIM unit produces one partial that must be merged on the host, so scaling stops when many units are busy.',
  imbalance: 1.0,
  computeTotals: (n, P) =>
    totals(4 * n, 0, n, 0, 0, 4 * n, 4 /* one scalar per unit */, 4, 1, 1),
}

/** Search / Select: count or copy matches */
export const select: Workload = {
  id: 'SEL',
  name: 'Search / Select',
  short: 'Select',
  description: 'Scan an array and select matching elements (~10% selectivity). Tiny output, tiny merge — a strong PIM case.',
  imbalance: 1.0,
  computeTotals: (n, P) =>
    totals(4 * n, 0.4 * n, 2 * n, 0, 0, 4 * n, 0.4 * n, 8, 1, 0),
}

/** Matrix–vector multiply: y = A·x (headline workload) */
export const gemv: Workload = {
  id: 'GEMV',
  name: 'Matrix–Vector Multiply  y = A·x',
  short: 'GEMV',
  description: 'Each row of A is read once and never reused; x is copied to every unit. Low arithmetic intensity — the headline PIM workload.',
  imbalance: 1.05,
  computeTotals: (n, P) => {
    const d = Math.max(2, Math.round(Math.sqrt(n))) // matrix is d×d
    const read = 4 * d * d + 4 * d // matrix + one pass over the vector x
    const out = 4 * d
    return totals(read, out, 2 * d * d, d * d, 0, 4 * d * d + 4 * d, out, 0, 0, 0)
  },
}

/** Tiled dense matrix multiply: C = A·B (CPU counterexample) */
export const gemm: Workload = {
  id: 'GEMM',
  name: 'Matrix Multiply (tiled)  C = A·B',
  short: 'GEMM',
  description: 'High data reuse: with tiling, each value is read once from memory but multiplied many times. The CPU caches handle it — the PIM counterexample.',
  imbalance: 1.0,
  computeTotals: (n, P) => {
    // interpret n loosely: total MACs ≈ n, d = n^(1/3), scaled for sensible sizes
    const d = Math.max(2, Math.round(2 * Math.cbrt(n)))
    const read = 12 * d * d // three matrices, streamed once thanks to tiling
    const out = 4 * d * d
    return totals(read, out, 2 * d * d * d, d * d * d, 0, read + out, out, 0, 0, 0)
  },
}

/** Histogram into 256 bins (stretch) */
export const histogram: Workload = {
  id: 'HST',
  name: 'Histogram (256 bins) *',
  short: 'Histogram',
  description: 'Counts elements into 256 bins. Every unit keeps its own 256-bin partial histogram; merging them is communication-limited. (stretch)',
  imbalance: 1.05,
  computeTotals: (n, P) =>
    totals(4 * n, 0, 3 * n, 0, 0, 4 * n, 0, 4 * 256, 256, 0),
}

/** Breadth-first search (stretch) */
export const bfs: Workload = {
  id: 'BFS',
  name: 'Breadth-First Search *',
  short: 'BFS',
  description: 'Random memory accesses over a graph plus a frontier exchange every level. Latency- and sync-limited — the hardest case for PIM. (stretch)',
  imbalance: 1.5,
  computeTotals: (n, P) =>
    totals(8 * n, 0, 2 * n, 0, 2 * n, 8 * n, 0, 4 * Math.max(1, Math.round(n / 4096)), 4, 16),
}

export const coreWorkloads: Workload[] = [vectorAdd, vectorMul, reduction, select, gemv, gemm]
export const stretchWorkloads: Workload[] = [histogram, bfs]
export const allWorkloads: Workload[] = [...coreWorkloads, ...stretchWorkloads]

export const workloadById = (id: string): Workload =>
  allWorkloads.find((w) => w.id === id) ?? vectorAdd
