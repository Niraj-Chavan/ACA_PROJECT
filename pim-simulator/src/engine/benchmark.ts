import type { Params } from './types'
import type { Task } from './tasks'
import {
  POLICIES,
  runSchedule,
  scheduleEnergyJ,
  type PolicyId,
  type Schedule,
} from './scheduler'
import {
  allocateMemory,
  type AllocPolicy,
  type MemoryOptions,
  type MemoryReport,
} from './memory'

/** Aggregate comparison of all scheduling policies on the same task set. */

export interface PolicyResult {
  policy: PolicyId
  label: string
  schedule: Schedule
  energyJ: number
  memory: MemoryReport
  speedup: number
}

export interface Comparison {
  tasks: Task[]
  dpus: number
  results: PolicyResult[]
  byPolicy: Record<PolicyId, PolicyResult>
  baselineMakespanS: number
  bestPolicy: PolicyId
  bestMakespanS: number
  /** improvement of adaptive over the best non-adaptive policy, 0 if it is not better */
  adaptiveGainVsBestBaseline: number
  adaptiveSpeedupVsCpu: number
}

export interface CompareOptions {
  memory?: MemoryOptions
  /** allocator used for the conflict column; bank-aware isolates scheduling */
  allocPolicy?: AllocPolicy
}

export function comparePolicies(
  tasks: Task[],
  params: Params,
  dpus: number,
  opts: CompareOptions = {}
): Comparison {
  const allocPolicy = opts.allocPolicy ?? 'bank-aware'
  const schedules = Object.fromEntries(
    POLICIES.map((p) => [p.id, runSchedule(tasks, params, dpus, p.id)])
  ) as Record<PolicyId, Schedule>
  const baselineMakespanS = schedules.cpu.makespanS

  const results: PolicyResult[] = POLICIES.map((p) => {
    const schedule = schedules[p.id]
    schedule.speedup = schedule.makespanS > 0 ? baselineMakespanS / schedule.makespanS : 0
    return {
      policy: p.id,
      label: p.label,
      schedule,
      energyJ: scheduleEnergyJ(schedule, params),
      memory: allocateMemory(schedule, tasks, params, allocPolicy, opts.memory),
      speedup: schedule.speedup,
    }
  })

  const best = results.reduce((a, b) => (b.schedule.makespanS < a.schedule.makespanS ? b : a))
  const nonAdaptive = results.filter((r) => r.policy !== 'adaptive')
  const bestBaseline = nonAdaptive.reduce((a, b) =>
    b.schedule.makespanS < a.schedule.makespanS ? b : a
  )
  const adaptive = results.find((r) => r.policy === 'adaptive')!

  return {
    tasks,
    dpus,
    results,
    byPolicy: Object.fromEntries(results.map((r) => [r.policy, r])) as Record<
      PolicyId,
      PolicyResult
    >,
    baselineMakespanS,
    bestPolicy: best.policy,
    bestMakespanS: best.schedule.makespanS,
    adaptiveGainVsBestBaseline:
      bestBaseline.schedule.makespanS > 0
        ? (bestBaseline.schedule.makespanS - adaptive.schedule.makespanS) /
          bestBaseline.schedule.makespanS
        : 0,
    adaptiveSpeedupVsCpu: adaptive.speedup,
  }
}
