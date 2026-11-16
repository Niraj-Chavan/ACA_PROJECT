import type { Params } from './types'
import { simulate } from './simulate'
import { workloadById } from './workloads'
import { generateTasks, type Task, type TaskKind } from './tasks'
import { runSchedule } from './scheduler'

/**
 * Optimisation studies for the Algorithm Lab.
 * Everything here is modelled; the measured anchors come from the saved DPU
 * runs and are shown separately in the UI.
 */

export interface DpuPoint {
  dpus: number
  makespanS: number
  speedupVsCpu: number
  pimUtilization: number
  cpuTasks: number
  pimTasks: number
}

export function optimizeDpus(
  params: Params,
  tasks: Task[],
  dpuChoices: number[]
): DpuPoint[] {
  const cpuBaseline = runSchedule(tasks, params, 1, 'cpu').makespanS
  return dpuChoices.map((dpus) => {
    const s = runSchedule(tasks, params, dpus, 'adaptive')
    return {
      dpus,
      makespanS: s.makespanS,
      speedupVsCpu: cpuBaseline > 0 ? cpuBaseline / s.makespanS : 0,
      pimUtilization: s.pimUtilization,
      cpuTasks: s.cpuTasks,
      pimTasks: s.pimTasks,
    }
  })
}

export interface ChunkPoint {
  chunks: number
  elementsPerTask: number
  makespanS: number
  speedupVsCpu: number
  pimUtilization: number
  cpuTasks: number
  pimTasks: number
}

export function optimizeChunks(
  params: Params,
  opts: { totalElements: number; dpus: number; kind?: TaskKind; counts: number[]; seed?: number }
): ChunkPoint[] {
  const probe = generateTasks(params, {
    count: opts.counts[0] ?? 8,
    totalElements: opts.totalElements,
    seed: opts.seed ?? 7,
    only: opts.kind,
  })
  const cpuBaseline = runSchedule(probe, params, 1, 'cpu').makespanS
  return opts.counts.map((chunks) => {
    const tasks = generateTasks(params, {
      count: chunks,
      totalElements: opts.totalElements,
      seed: opts.seed ?? 7,
      only: opts.kind,
    })
    const s = runSchedule(tasks, params, opts.dpus, 'adaptive')
    return {
      chunks,
      elementsPerTask: Math.round(opts.totalElements / chunks),
      makespanS: s.makespanS,
      speedupVsCpu: cpuBaseline > 0 ? cpuBaseline / s.makespanS : 0,
      pimUtilization: s.pimUtilization,
      cpuTasks: s.cpuTasks,
      pimTasks: s.pimTasks,
    }
  })
}

export interface CrossPoint {
  n: number
  cpuTimeS: number
  pimTimeS: number
  speedup: number
}

/** Speedup vs element count with the current parameters and a fixed DPU count. */
export function crossoverCurve(
  params: Params,
  workloadId: string,
  dpus: number,
  points: number[]
): CrossPoint[] {
  const p: Params = JSON.parse(JSON.stringify(params))
  p.pim.banks = Math.max(1, Math.floor(dpus))
  p.pim.unitsPerBank = 1
  const wl = workloadById(workloadId)
  return points.map((n) => {
    const r = simulate(p, wl, Math.max(64, Math.round(n)))
    return { n, cpuTimeS: r.cpu.time, pimTimeS: r.pim.time, speedup: r.speedup }
  })
}

/** First element count on the curve where PIM overtakes the CPU. */
export function firstCrossover(points: CrossPoint[]): CrossPoint | null {
  return points.find((p) => p.speedup > 1) ?? null
}
