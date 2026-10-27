import type { Params, Result, Phase, Workload, EnergyParts } from './types'
import { cpuModel } from './cpuModel'
import { pimModel } from './pimModel'
import { energyModel, energyTotal } from './energy'
import { computeBankUtilization } from './bankUtilization'

/**
 * Combines the CPU, PIM and energy models into one Result (Appendix D),
 * including a phase timeline used by the animated datapath.
 */

export function simulate(params: Params, workload: Workload, n: number): Result {
  const P = Math.max(1, Math.round(params.pim.banks * params.pim.unitsPerBank))
  const t = workload.computeTotals(n, P)

  const cpu = cpuModel(params.cpu, t)
  const pim = pimModel(
    params.pim,
    t,
    { dataResident: params.dataResident, resultNeededOnHost: params.resultNeededOnHost ?? true },
    n,
    workload.imbalance
  )
  const energy = energyModel(params.energy, t, cpu, pim)

  const kernelBytesTotal = t.readBytes + t.writtenBytes

  const throughput = (ops: number, time: number) => (time > 0 ? ops / time : 0)

  const speedup = pim.time > 0 ? cpu.time / pim.time : Infinity
  const eCpu = energyTotal(energy.cpu)
  const ePim = energyTotal(energy.pim)
  const energySaving = eCpu > 0 ? ((eCpu - ePim) / eCpu) * 100 : 0

  // Break-even runs: (copy-in + copy-out) vs per-run kernel saving
  const copyTotal = pim.copyIn + pim.copyOut
  const kernelSaving = cpu.time - pim.kernelTime
  const breakEvenRuns =
    !params.dataResident && kernelSaving > 0 ? copyTotal / kernelSaving : null

  // ---- phase timelines (Appendix D) ---------------------------------------
  const cpuTimeline: Phase[] = [
    { name: 'Stream data over bus', kind: 'stream', seconds: cpu.memTime },
    { name: 'Compute', kind: 'overlap', seconds: Math.max(0, cpu.time - cpu.memTime) },
  ]
  const pimTimeline: Phase[] = [
    { name: 'Copy-in', kind: 'copyIn', seconds: pim.copyIn + pim.launch },
    { name: 'PIM kernel (all units)', kind: 'kernel', seconds: pim.kernel },
    { name: 'Merge partials', kind: 'merge', seconds: pim.mergeTime },
    { name: 'Copy-out', kind: 'copyOut', seconds: pim.copyOut },
  ]

  const bankUtil = computeBankUtilization(params, t, cpu, pim, n)

  const ones: EnergyParts = { movement: 1, inBank: 1, compute: 1, static: 1 }

  return {
    n,
    workload: workload.id,
    preset: params.preset,
    cpu: {
      time: cpu.time,
      memTime: cpu.memTime,
      computeTime: cpu.computeTime,
      bytes: cpu.bytes,
      accesses: cpu.accesses,
      energy: energy.cpu,
      throughput: throughput(t.ops, cpu.time),
      bound: cpu.bound,
    },
    pim: {
      time: pim.time,
      copyIn: pim.copyIn + pim.launch,
      kernel: pim.kernel,
      bankTime: pim.bankTime,
      computeTime: pim.computeTime,
      merge: pim.mergeTime,
      copyOut: pim.copyOut,
      overhead: pim.launch + pim.sync,
      bytesOffchip: pim.bytesOffchip,
      accesses: kernelBytesTotal / 64,
      energy: energy.pim,
      throughput: throughput(t.ops, pim.time),
      bound: pim.bound,
    },
    speedup,
    energySaving,
    arithmeticIntensity: cpu.bytes + t.randomAccesses * 1 > 0 ? t.ops / (cpu.bytes + t.randomAccesses * 64) : 0,
    breakEvenRuns,
    timeline: { cpu: cpuTimeline, pim: pimTimeline },
    units: pim.P,
    kernelBytes: kernelBytesTotal,
  }
}

/** phantom usage guard so tree-shaking keeps the type import meaningful */
export type { EnergyParts }
