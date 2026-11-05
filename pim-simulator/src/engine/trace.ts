import type { Params, Result, WorkTotals, Workload } from './types'
import { cpuModel } from './cpuModel'
import { pimModel, type PimMid } from './pimModel'
import { energyModel, energyTotal } from './energy'
import { simulate } from './simulate'
import { fmtBytes, fmtEnergy, fmtSpeedup, fmtTime } from './format'

/**
 * Formula trace: every number the simulator reports, decomposed into the
 * analytical-model terms that produced it. The dashboard renders this as a
 * step-by-step "show your work" inspector, so the model is auditable instead
 * of a black box.
 *
 * Sources of each formula: docs/model-spec.md, Appendix A of the project plan.
 */

export type TraceUnit = 's' | 'x' | '%' | 'runs' | 'J' | 'ops/B'
export type TraceGroup = 'CPU' | 'PIM' | 'Verdict'

export interface TraceStep {
  id: string
  label: string
  group: TraceGroup
  /** symbolic formula, e.g. "T_stream = B / BW_mem" */
  formula: string
  /** the same formula with this run's numbers substituted */
  substitute: string
  value: number
  unit: TraceUnit
  /** why this term exists / what would change it */
  note: string
  /** largest term of its group (the critical path) */
  dominant: boolean
  /** winner of a max(...) / branch choice */
  peak: boolean
}

export interface TraceResult {
  steps: TraceStep[]
  result: Result
  totals: WorkTotals
  pim: PimMid
  cpu: ReturnType<typeof cpuModel>
}

const INBANK_RANDOM_NS = 60
const HOST_MERGE_RATE = 2e9

function timeStep(
  id: string,
  label: string,
  group: TraceGroup,
  formula: string,
  substitute: string,
  value: number,
  note: string
): TraceStep {
  return {
    id,
    label,
    group,
    formula,
    substitute,
    value: Math.max(0, value),
    unit: 's',
    note,
    dominant: false,
    peak: false,
  }
}

/**
 * Build the full trace for one configuration.
 * Pure function: same inputs -> same steps, no store access.
 */
export function formulaTrace(params: Params, workload: Workload, n: number): TraceResult {
  const totals = workload.computeTotals(n, Math.max(1, Math.round(params.pim.banks * params.pim.unitsPerBank)))
  const cpu = cpuModel(params.cpu, totals)
  const pim = pimModel(
    params.pim,
    totals,
    { dataResident: params.dataResident, resultNeededOnHost: params.resultNeededOnHost ?? true },
    n,
    workload.imbalance
  )
  const energy = energyModel(params.energy, totals, cpu, pim)
  const result = simulate(params, workload, n)

  const steps: TraceStep[] = []
  const add = (s: TraceStep) => steps.push(s)

  // ---- conventional CPU ---------------------------------------------------
  add(
    timeStep(
      'cpu-stream',
      'Stream data over the bus',
      'CPU',
      'T_stream = (B_read + B_write) / BW_mem',
      `${fmtBytes(cpu.bytes)} ÷ ${params.cpu.memBWGBs} GB/s = ${fmtTime(cpu.streamSeconds)}`,
      cpu.streamSeconds,
      'Every input and output byte crosses the off-chip memory bus on a CPU. This term is bandwidth, not latency: it shrinks only if the bus gets wider.'
    )
  )
  add(
    timeStep(
      'cpu-random',
      'Random-access stalls',
      'CPU',
      'T_random = (R × t_mem) / (cores × MLP)',
      `${totals.randomAccesses.toLocaleString()} accesses × ${params.cpu.memLatencyNs} ns ÷ (${params.cpu.cores} × ${params.cpu.mlp}) = ${fmtTime(cpu.randomSeconds)}`,
      cpu.randomSeconds,
      'Uncached accesses expose DRAM latency. Memory-level parallelism (MLP) hides it, so the cost is divided by cores × outstanding misses.'
    )
  )
  const memTime = cpu.streamSeconds + cpu.randomSeconds
  add(
    timeStep(
      'cpu-mem',
      'CPU memory time',
      'CPU',
      'T_mem = T_stream + T_random',
      `${fmtTime(cpu.streamSeconds)} + ${fmtTime(cpu.randomSeconds)} = ${fmtTime(memTime)}`,
      memTime,
      'The bus serialises streaming and scattered traffic, so the two add up.'
    )
  )
  add(
    timeStep(
      'cpu-compute',
      'CPU compute time',
      'CPU',
      'T_compute = O / (cores × f × IPC)',
      `${totals.ops.toLocaleString()} ops ÷ (${params.cpu.cores} × ${params.cpu.freqGHz} GHz × ${params.cpu.opsPerCycle}) = ${fmtTime(cpu.computeTime)}`,
      cpu.computeTime,
      'Peak arithmetic throughput. On a modern core many instructions retire per cycle, so this term is usually far smaller than memory time for streaming workloads.'
    )
  )
  add(
    timeStep(
      'cpu-total',
      'T_CPU (critical path)',
      'CPU',
      'T_CPU = max(T_mem, T_compute)',
      `max(${fmtTime(memTime)}, ${fmtTime(cpu.computeTime)}) = ${fmtTime(cpu.time)}`,
      cpu.time,
      'A CPU overlaps memory and compute, so the run takes the longer of the two — it does not pay their sum. The bound chip below says which roof this run sits under.'
    )
  )

  // ---- PIM ----------------------------------------------------------------
  add(
    timeStep(
      'pim-copyin',
      'Copy-in to DPUs',
      'PIM',
      'T_in = B_input / BW_copy',
      `${fmtBytes(pim.copyInBytes)} ÷ ${params.pim.copyBWGBs} GB/s = ${fmtTime(pim.copyIn)}`,
      pim.copyIn,
      params.dataResident
        ? 'Data is marked resident, so nothing crosses the bus on this run: T_in = 0. The model still tells you what a cold run would cost.'
        : 'Only data that is not already in the banks pays this. It is the first term marketing slides omit, and the reason PIM loses on one-shot streaming.'
    )
  )
  add(
    timeStep(
      'pim-launch',
      'Kernel launch',
      'PIM',
      'T_launch = launch_us',
      `${params.pim.launchUs} µs = ${fmtTime(pim.launch)}`,
      pim.launch,
      'Fixed host → device dispatch cost. It dominates for tiny inputs and disappears for long kernels.'
    )
  )
  const kernelBytes = ((totals.readBytes + totals.writtenBytes) / Math.max(n, 1)) * (n / pim.P) * workload.imbalance
  add(
    timeStep(
      'pim-bank',
      'Bank / MRAM time',
      'PIM',
      'T_bank = B_kernel / BW_bank + (R/P) × 60 ns',
      `${fmtBytes(kernelBytes)} ÷ ${params.pim.bankBWGBs} GB/s + ${(totals.randomAccesses / pim.P).toLocaleString()} × 60 ns = ${fmtTime(pim.bankTime)}`,
      pim.bankTime,
      'The DPU reads its own MRAM at bank bandwidth, with a 256-byte DMA burst. There is no cache: every reused value must be staged in WRAM by software.'
    )
  )

  // op-mix correction: a multiply is not a free add on a slow PIM core
  add({
    id: 'pim-c',
    label: 'Op-mix correction c',
    group: 'PIM',
    formula: 'c = (1 − f_mul) + f_mul × c_mul',
    substitute: `(1 − ${(pim.mulFrac * 100).toFixed(1)}%) + ${(pim.mulFrac * 100).toFixed(1)}% × ${params.pim.mulCost} = ${pim.c.toFixed(2)}×`,
    value: pim.c,
    unit: 'x',
    note: `UPMEM's ISA does not have a single-cycle integer multiply; a multiply costs ≈${params.pim.mulCost}× an add. This factor scales compute time by the fraction of multiply operations in the workload.`,
    dominant: false,
    peak: false,
  })

  add(
    timeStep(
      'pim-compute',
      'PIM compute time',
      'PIM',
      'T_pcomp = (O/P) × c / (f_pim × IPC_pim)',
      `${((totals.ops / pim.P) * pim.c).toLocaleString(undefined, { maximumFractionDigits: 0 })} ops ÷ (${params.pim.freqGHz} GHz × ${params.pim.opsPerCycle}) = ${fmtTime(pim.computeTime)}`,
      pim.computeTime,
      'Each DPU executes its slice with simple in-order RISC lanes. Low frequency and missing vector units are why PIM compute is not free; c accounts for the multiply penalty.'
    )
  )
  add(
    timeStep(
      'pim-kernel',
      'PIM kernel time',
      'PIM',
      'T_kernel = max(T_bank, T_pcomp)',
      `max(${fmtTime(pim.bankTime)}, ${fmtTime(pim.computeTime)}) = ${fmtTime(pim.kernelTime)}`,
      pim.kernelTime,
      'Banks and lanes pipeline, so the kernel takes the longer of data movement and arithmetic. Whichever term wins tells you whether to tune bandwidth or the instruction mix.'
    )
  )
  add(
    timeStep(
      'pim-merge',
      'Merge partials on host',
      'PIM',
      'T_merge = B_partials / BW_copy + (P × merge_ops) / 2 Gops/s',
      `${fmtBytes(pim.partials)} ÷ ${params.pim.copyBWGBs} GB/s + (${pim.P} × ${totals.mergeOpsPerUnit}) ÷ 2 Gops/s = ${fmtTime(pim.mergeTime)}`,
      pim.mergeTime,
      'When each unit produces a partial, the host must combine them. This term grows with P and is why reduction scaling flattens: more units means more partials to merge.'
    )
  )
  add(
    timeStep(
      'pim-copyout',
      'Copy-out results',
      'PIM',
      'T_out = B_output / BW_copy',
      `${fmtBytes(pim.copyOutBytes)} ÷ ${params.pim.copyBWGBs} GB/s = ${fmtTime(pim.copyOut)}`,
      pim.copyOut,
      params.resultNeededOnHost
        ? 'Only the result crosses the bus, not the input. Small outputs are cheap; a full matrix result is not.'
        : 'The result stays in the PIM banks, so T_out = 0. Set "result needed on host" to see the copy-out cost return.'
    )
  )
  add(
    timeStep(
      'pim-sync',
      'Barriers / synchronisation',
      'PIM',
      'T_sync = syncs × sync_us',
      `${totals.syncs} × ${params.pim.syncUs} µs = ${fmtTime(pim.sync)}`,
      pim.sync,
      'Tasklets inside a DPU (and units across a set) must rendezvous. The barrier is cheap per event but repeated every algorithm level.'
    )
  )
  add(
    timeStep(
      'pim-total',
      'T_PIM (critical path)',
      'PIM',
      'T_PIM = T_in + T_launch + T_kernel + T_merge + T_out + T_sync',
      `${fmtTime(pim.copyIn)} + ${fmtTime(pim.launch)} + ${fmtTime(pim.kernelTime)} + ${fmtTime(pim.mergeTime)} + ${fmtTime(pim.copyOut)} + ${fmtTime(pim.sync)} = ${fmtTime(pim.time)}`,
      pim.time,
      'Unlike the CPU, these phases are serial in the model: data must arrive before the kernel runs, and partials must return before the host can merge them.'
    )
  )

  // ---- verdict ------------------------------------------------------------
  add({
    id: 'speedup',
    label: 'Speedup',
    group: 'Verdict',
    formula: 'S = T_CPU / T_PIM',
    substitute: `${fmtTime(cpu.time)} ÷ ${fmtTime(pim.time)} = ${fmtSpeedup(result.speedup)}`,
    value: result.speedup,
    unit: 'x',
    note: 'Above 1× PIM wins. The interesting part is why: usually a bandwidth advantage eaten by copy and merge overheads, not raw compute.',
    dominant: false,
    peak: false,
  })

  const eCpu = energyTotal(energy.cpu)
  const ePim = energyTotal(energy.pim)
  add({
    id: 'energy',
    label: 'Energy per run',
    group: 'Verdict',
    formula: 'E = E_move + E_bank + E_compute + E_static',
    substitute: `CPU ${fmtEnergy(eCpu)} · PIM ${fmtEnergy(ePim)} · saving ${result.energySaving.toFixed(1)}%`,
    value: ePim,
    unit: 'J',
    note: 'PIM saves the off-chip movement energy because data stays in the bank; it still pays in-bank access, arithmetic and static power. A negative saving means the PIM run burns more total energy.',
    dominant: false,
    peak: false,
  })

  add({
    id: 'breakeven',
    label: 'Break-even runs',
    group: 'Verdict',
    formula: 'Runs* = (T_in + T_out) / (T_CPU − T_kernel)',
    substitute:
      result.breakEvenRuns === null
        ? 'n/a — data is resident or the kernel is not faster than the CPU'
        : `${fmtTime(pim.copyIn + pim.copyOut)} ÷ ${fmtTime(cpu.time - pim.kernelTime)} = ${result.breakEvenRuns.toFixed(2)} runs`,
    value: result.breakEvenRuns ?? 0,
    unit: 'runs',
    note: 'How many times the same resident data must be processed before the one-off copy cost is repaid. Below ~1 the copy pays for itself within a single run; large values mean PIM only makes sense for repeated kernels.',
    dominant: false,
    peak: false,
  })

  add({
    id: 'intensity',
    label: 'Arithmetic intensity',
    group: 'Verdict',
    formula: 'AI = O / (B + R × 64 B)',
    substitute: `${totals.ops.toLocaleString()} ops ÷ ${fmtBytes(cpu.bytes + totals.randomAccesses * 64)} = ${result.arithmeticIntensity.toFixed(3)} ops/B`,
    value: result.arithmeticIntensity,
    unit: 'ops/B',
    note: 'Ops per byte moved. Low AI (<1) means the roofline is bandwidth-limited and PIM looks attractive; high AI means the CPU caches already hide memory and PIM compute is too slow.',
    dominant: false,
    peak: false,
  })

  // ---- annotate the critical path -----------------------------------------
  const leaf = (group: TraceGroup, ids: string[]) => {
    const candidates = steps.filter((s) => group === s.group && ids.includes(s.id))
    if (!candidates.length) return
    const winner = candidates.reduce((a, b) => (b.value > a.value ? b : a))
    winner.dominant = true
  }
  leaf('CPU', ['cpu-stream', 'cpu-random', 'cpu-compute'])
  leaf('PIM', ['pim-copyin', 'pim-launch', 'pim-bank', 'pim-compute', 'pim-merge', 'pim-copyout', 'pim-sync'])

  // winners of the max() choices
  const peak = (id: string, condition: boolean) => {
    const step = steps.find((s) => s.id === id)
    if (step && condition) step.peak = true
  }
  peak('cpu-compute', cpu.computeTime >= memTime)
  peak('cpu-mem', memTime > cpu.computeTime)
  peak('pim-compute', pim.computeTime >= pim.bankTime)
  peak('pim-bank', pim.bankTime > pim.computeTime)

  return { steps, result, totals, pim, cpu }
}

/** Human-readable value for a trace row. */
export function traceValue(step: TraceStep): string {
  switch (step.unit) {
    case 's':
      return fmtTime(step.value)
    case 'x':
      return fmtSpeedup(step.value)
    case '%':
      return `${step.value.toFixed(1)}%`
    case 'runs':
      return step.value.toFixed(2)
    case 'J':
      return fmtEnergy(step.value)
    case 'ops/B':
      return step.value.toFixed(3)
    default:
      return String(step.value)
  }
}
