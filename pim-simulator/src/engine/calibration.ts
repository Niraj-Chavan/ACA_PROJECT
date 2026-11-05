import type { Params, Result } from './types'
import { simulate } from './simulate'
import { workloadById } from './workloads'

/**
 * Calibration ledger.
 *
 * Two kinds of numbers meet here:
 *  - values measured from the real UPMEM toolchain (host-side transfer timings
 *    and on-chip perfcounter cycles from the kernels in pim-kernels/), and
 *  - published PrIM / UPMEM numbers for things a functional simulator cannot
 *    model (bank bandwidth, energy per bit, instruction latencies).
 *
 * Keeping the source on every row is the point: a viva panel should be able to
 * ask "where did that constant come from?" and get an answer.
 */

export interface CalibrationRow {
  id: string
  label: string
  assumed: (p: Params) => number
  measured: number
  unit: string
  source: 'DPU sim' | 'PrIM 2022' | 'SDK spec' | 'DDR spec' | 'assumption'
  note: string
  patch?: { section: 'cpu' | 'pim' | 'energy'; key: string; value: number }
}

export const CALIBRATION: CalibrationRow[] = [
  {
    id: 'copybw',
    label: 'Host ↔ DPU copy bandwidth',
    assumed: (p) => p.pim.copyBWGBs,
    measured: 7.65,
    unit: 'GB/s',
    source: 'DPU sim',
    note: 'Measured from the VA/GEMV/RED copy-in phases of the real runs: 32 MiB in 4.37 ms and 16 MiB in 2.20 ms. Marked "DPU sim" because the UPMEM functional simulator executes the actual SDK transfer path; a physical UPMEM box would be quoted instead.',
    patch: { section: 'pim', key: 'copyBWGBs', value: 7.65 },
  },
  {
    id: 'mulcost',
    label: 'Integer multiply cost (× add)',
    assumed: (p) => p.pim.mulCost,
    measured: 3.33,
    unit: '× add',
    source: 'DPU sim',
    note: 'Back-solved from the GEMV perfcounter: 27,362,256 cycles for 2.10 M ops/DPU at 0.166 ops/cycle gives an effective c = 2.17. With a 50% multiply share, c_mul = (c − 0.5)/0.5 ≈ 3.33. PrIM reports a higher 5.7× on silicon; the simulator understates the software-multiply sequence.',
    patch: { section: 'pim', key: 'mulCost', value: 3.33 },
  },
  {
    id: 'bankbw',
    label: 'Per-DPU MRAM bandwidth',
    assumed: (p) => p.pim.bankBWGBs,
    measured: 0.63,
    unit: 'GB/s',
    source: 'PrIM 2022',
    note: 'Gómez-Luna et al., IEEE Access 2022: one DPU sustains ≈0.63 GB/s from its bank with 256-byte DMA bursts. The functional simulator does not model bank contention, so the published figure is used.',
    patch: { section: 'pim', key: 'bankBWGBs', value: 0.63 },
  },
  {
    id: 'freq',
    label: 'DPU clock',
    assumed: (p) => p.pim.freqGHz,
    measured: 0.35,
    unit: 'GHz',
    source: 'SDK spec',
    note: 'UPMEM DPU nominal clock in the 2025.1 SDK documentation. The perfcounter is expressed in these cycles.',
    patch: { section: 'pim', key: 'freqGHz', value: 0.35 },
  },
  {
    id: 'ipc',
    label: 'DPU throughput per cycle',
    assumed: (p) => p.pim.opsPerCycle,
    measured: 0.166,
    unit: 'ops/cycle',
    source: 'PrIM 2022',
    note: '≈58 MOPS per DPU for 32-bit integer additions at 0.35 GHz. The DPU is in-order and has no vector unit, so its per-cycle throughput is far below a CPU core.',
    patch: { section: 'pim', key: 'opsPerCycle', value: 0.166 },
  },
  {
    id: 'offchip',
    label: 'Off-chip energy per byte',
    assumed: (p) => p.energy.offchipPJperB,
    measured: 160,
    unit: 'pJ/B',
    source: 'DDR spec',
    note: 'Horowitz, ISSCC 2014: moving one byte off-chip costs roughly two orders of magnitude more than an in-bank access. This is the energy argument for PIM.',
  },
  {
    id: 'launch',
    label: 'Kernel launch overhead',
    assumed: (p) => p.pim.launchUs,
    measured: 50,
    unit: 'µs',
    source: 'assumption',
    note: 'Fixed dispatch cost assumed for a DPU set. The simulator reports 0.2–1.4 s of host wall time for a launch, but that is functional simulation overhead, not device launch latency — it is deliberately not used for calibration.',
    patch: { section: 'pim', key: 'launchUs', value: 50 },
  },
]

/** Rebuild params with every measured/published override applied. */
export function calibratedParams(base: Params): Params {
  const params = JSON.parse(JSON.stringify(base)) as Params
  for (const row of CALIBRATION) {
    if (row.patch) {
      ;(params[row.patch.section] as unknown as Record<string, number>)[row.patch.key] = row.patch.value
    }
  }
  return params
}

/** Actual runs produced by pim-kernels/ on this machine, 4 DPUs, 16 tasklets. */
export const MEASURED_RUNS = [
  {
    kernel: 'VA',
    dpus: 4,
    n: 4_194_304,
    cycles: 12_812_752,
    copyInMs: 4.374,
    copyInBytes: 33_554_432,
    launchMs: 416.305,
  },
  {
    kernel: 'GEMV',
    dpus: 4,
    n: 4_194_304,
    cycles: 27_362_256,
    copyInMs: 2.2,
    copyInBytes: 16_793_600,
    launchMs: 1447.643,
  },
  {
    kernel: 'RED',
    dpus: 4,
    n: 4_194_304,
    cycles: 5_375_760,
    copyInMs: 2.195,
    copyInBytes: 16_777_216,
    launchMs: 189.221,
  },
]

export function effectiveCopyGBs(run: (typeof MEASURED_RUNS)[number]): number {
  return run.copyInBytes / (run.copyInMs * 1e6)
}

export interface RunPrediction {
  result: Result
  /** model's kernel time for the same number of units */
  predictedKernelS: number
  /** perfcounter cycles / DPU clock */
  measuredKernelS: number
  errorPct: number | null
}

/**
 * Predict a concrete measured run with the analytical model, holding the
 * measured configuration fixed (P = number of DPUs, n = meta.n).
 */
export function predictRun(
  params: Params,
  kernel: string,
  dpus: number,
  n: number,
  cycles: number,
  freqGHz = params.pim.freqGHz
): RunPrediction {
  const p = JSON.parse(JSON.stringify(params)) as Params
  p.pim.banks = Math.max(1, dpus)
  p.pim.unitsPerBank = 1
  const result = simulate(p, workloadById(kernel), n)
  const measuredKernelS = cycles / (freqGHz * 1e9)
  const errorPct =
    measuredKernelS > 0 ? ((result.pim.kernel - measuredKernelS) / measuredKernelS) * 100 : null
  return { result, predictedKernelS: result.pim.kernel, measuredKernelS, errorPct }
}
