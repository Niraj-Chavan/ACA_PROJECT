import type { Params, Result, Workload } from './types'
import { simulate } from './simulate'

/**
 * PIM Suitability Score (Phase 6A).
 * Four factors, each 0–1, computed from the model; weights are fitted with
 * logistic regression against the label speedup > 1 over ~500 random
 * configurations, and accuracy plus Spearman correlation are reported.
 */

export interface SuitabilityFactors {
  memoryIntensity: number // 1 − min(1, AI ÷ ridge_CPU)
  parallelism: number // 1 − (merge + syncs) ÷ T_PIM
  dataMovementSaved: number // 1 − PIM_offchip ÷ CPU_offchip
  computeFit: number // min(1, T_bank ÷ T_pim_compute)
}

export interface Suitability {
  score: number // 0–100
  factors: SuitabilityFactors
  label: string
  recommendation: string
}

export const DEFAULT_WEIGHTS = { w1: 0.35, w2: 0.25, w3: 0.25, w4: 0.15 }

/**
 * Compute suitability directly from a fresh simulation.
 */
export function computeSuitability(
  params: Params,
  workload: Workload,
  n: number,
  weights = DEFAULT_WEIGHTS
): Suitability {
  const r = simulate(params, workload, n)
  return suitabilityFromResult(r, weights)
}

export function suitabilityFromResult(
  r: Result,
  weights = DEFAULT_WEIGHTS
): Suitability {
  const factors = factorsFromResult(r)
  const score = Math.round(
    100 * (weights.w1 * factors.memoryIntensity + weights.w2 * factors.parallelism + weights.w3 * factors.dataMovementSaved + weights.w4 * factors.computeFit)
  )

  const label =
    score >= 70 ? 'Highly suitable' : score >= 45 ? 'Moderately suitable' : 'Not suitable'

  const parts: string[] = []
  if (factors.memoryIntensity > 0.7) parts.push('the workload is strongly memory-bound on the CPU')
  if (factors.parallelism > 0.7) parts.push('little time is lost to communication')
  if (factors.dataMovementSaved > 0.8) parts.push('PIM removes most of the bus traffic')
  if (factors.computeFit > 0.7) parts.push('the PIM cores keep up with the banks')
  const recommendation =
    score >= 70
      ? `PIM is recommended: ${parts.slice(0, 2).join(', ') || 'the model favours PIM'}.`
      : score >= 45
        ? 'PIM may help on parts of the workload; check the break-even runs and data placement.'
        : 'PIM is not recommended for this configuration — the CPU wins on time or energy.'

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
    label,
    recommendation,
  }
}

// ---------------------------------------------------------------------------
// Validation: random configs, logistic-regression-fitted weights, accuracy
// ---------------------------------------------------------------------------

export interface ValRow {
  factors: SuitabilityFactors
  speedup: number
  label: number // 1 if speedup > 1
}

export interface ValidationReport {
  rows: number
  spearman: number
  accuracy: number
  threshold: number // best score cutoff for predicting a PIM win
  weights: { w1: number; w2: number; w3: number; w4: number }
}

/** deterministic PRNG so validation is reproducible */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateValidationConfigs(
  paramsSets: Params[],
  workloads: Workload[],
  count = 500,
  seed = 42
): { params: Params; workload: Workload; n: number }[] {
  const rng = mulberry32(seed)
  const out: { params: Params; workload: Workload; n: number }[] = []
  for (let i = 0; i < count; i++) {
    const params = JSON.parse(
      JSON.stringify(paramsSets[Math.floor(rng() * paramsSets.length)])
    ) as Params
    const workload = workloads[Math.floor(rng() * workloads.length)]
    params.pim.banks = Math.round(Math.pow(10, 0.0 + rng() * 3.61)) // 1 … ~4096
    params.cpu.memBWGBs = 12.5 + rng() * 187.5
    params.cpu.memLatencyNs = 50 + rng() * 250
    params.dataResident = rng() < 0.4
    const dataBytes = Math.pow(10, 3 + rng() * 7) // 1 KB … 10 GB
    out.push({ params, workload, n: Math.max(64, Math.round(dataBytes / 4)) })
  }
  return out
}

export function scoreOf(f: SuitabilityFactors, weights: typeof DEFAULT_WEIGHTS): number {
  return 100 * (weights.w1 * f.memoryIntensity + weights.w2 * f.parallelism + weights.w3 * f.dataMovementSaved + weights.w4 * f.computeFit)
}

export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const r = new Array(n).fill(0)
    for (let i = 0; i < n; i++) r[idx[i].i] = i + 1
    return r
  }
  const rx = rank(xs)
  const ry = rank(ys)
  let sum = 0
  for (let i = 0; i < n; i++) sum += (rx[i] - ry[i]) ** 2
  if (n < 2) return 0
  return 1 - (6 * sum) / (n * (n * n - 1))
}

/** fit weights with simple logistic regression via gradient descent */
export function fitLogisticWeights(rows: ValRow[]): typeof DEFAULT_WEIGHTS {
  const lr = 0.1
  const w = [0.25, 0.25, 0.25, 0.25]
  for (let epoch = 0; epoch < 300; epoch++) {
    const grad = [0, 0, 0, 0]
    for (const row of rows) {
      const x = [
        row.factors.memoryIntensity,
        row.factors.parallelism,
        row.factors.dataMovementSaved,
        row.factors.computeFit,
      ]
      const z = x[0] * w[0] + x[1] * w[1] + x[2] * w[2] + x[3] * w[3]
      const p = 1 / (1 + Math.exp(-z))
      const err = p - row.label
      for (let i = 0; i < 4; i++) grad[i] += err * x[i]
    }
    for (let i = 0; i < 4; i++) {
      w[i] = Math.max(0, w[i] - (lr / rows.length) * grad[i]) // keep weights non-negative
    }
    const s = w.reduce((a, b) => a + b, 0)
    if (s > 0) for (let i = 0; i < 4; i++) w[i] /= s // normalise to sum 1
  }
  return { w1: w[0], w2: w[1], w3: w[2], w4: w[3] }
}

export function validateScore(
  paramsSets: Params[],
  workloads: Workload[],
  count = 500,
  seed = 42
): ValidationReport {
  const configs = generateValidationConfigs(paramsSets, workloads, count, seed)
  const rows: ValRow[] = []
  for (const cfg of configs) {
    const r = simulate(cfg.params, cfg.workload, cfg.n)
    if (!isFinite(r.speedup) || r.speedup <= 0) continue
    rows.push({
      factors: factorsFromResult(r),
      speedup: r.speedup,
      label: r.speedup > 1 ? 1 : 0,
    })
  }
  const weights = fitLogisticWeights(rows)
  const scores = rows.map((r) => scoreOf(r.factors, weights))
  const logSpeedup = rows.map((r) => Math.log(Math.max(r.speedup, 1e-3)))
  const spear = spearman(scores, logSpeedup)

  // best threshold for accuracy
  let best = { acc: 0, thr: 50 }
  for (let thr = 10; thr <= 90; thr += 2) {
    let correct = 0
    for (let i = 0; i < rows.length; i++)
      if ((scores[i] >= thr ? 1 : 0) === rows[i].label) correct++
    if (correct / rows.length > best.acc) best = { acc: correct / rows.length, thr }
  }

  return { rows: rows.length, spearman: spear, accuracy: best.acc, threshold: best.thr, weights }
}

function factorsFromResult(r: Result): SuitabilityFactors {
  const peakCpuOps = r.cpu.throughput * (r.cpu.time / Math.max(r.cpu.computeTime, 1e-12))
  const cpuBytesPerSec = r.cpu.bytes / Math.max(r.cpu.memTime, 1e-12)
  const ridgeCpu = peakCpuOps / Math.max(cpuBytesPerSec, 1)
  const f1 = 1 - Math.min(1, r.arithmeticIntensity / Math.max(ridgeCpu, 1e-12))
  const commTime = r.pim.merge + r.pim.overhead
  const f2 = Math.max(0, 1 - commTime / Math.max(r.pim.time, 1e-12))
  const f3 = Math.max(0, Math.min(1, 1 - r.pim.bytesOffchip / Math.max(r.cpu.bytes, 1)))
  const f4 = Math.min(1, r.pim.bankTime / Math.max(r.pim.computeTime, 1e-12))
  return { memoryIntensity: f1, parallelism: f2, dataMovementSaved: f3, computeFit: f4 }
}
