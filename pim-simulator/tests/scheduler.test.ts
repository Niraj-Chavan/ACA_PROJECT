import { describe, it, expect } from 'vitest'
import { defaultParams } from '../src/engine/params'
import { generateTasks, pimTaskCost } from '../src/engine/tasks'
import { runSchedule } from '../src/engine/scheduler'
import { comparePolicies } from '../src/engine/benchmark'
import { compareAllocators } from '../src/engine/memory'

const resident = { ...defaultParams, dataResident: true }
const cold = { ...defaultParams, dataResident: false }
const OPTS = { count: 32, totalElements: 1_000_000, seed: 42 }
const MEM = { banksPerDpu: 16, capacityBytes: 64 * 1024 }

describe('task generation', () => {
  it('is deterministic and conserves the requested element total', () => {
    const a = generateTasks(resident, OPTS)
    const b = generateTasks(resident, OPTS)
    expect(a.map((t) => t.kind)).toEqual(b.map((t) => t.kind))
    expect(a.map((t) => t.elements)).toEqual(b.map((t) => t.elements))
    expect(a.reduce((sum, t) => sum + t.elements, 0)).toBe(1_000_000)
    expect(new Set(a.map((t) => t.kind)).size).toBe(6)
  })

  it('charges copy-in only for cold data', () => {
    const warm = generateTasks(resident, OPTS)[0]
    const chill = generateTasks(cold, OPTS)[0]
    expect(warm.pim1S).toBeLessThan(chill.pim1S)
    expect(pimTaskCost(warm, 1, resident).copyInS).toBe(0)
    expect(pimTaskCost(chill, 1, cold).copyInS).toBeGreaterThan(0)
  })
})

describe('adaptive scheduler at 1M elements / 8 DPUs', () => {
  const tasks = generateTasks(resident, OPTS)
  const c = comparePolicies(tasks, resident, 8, { memory: MEM })
  const adaptive = c.byPolicy.adaptive.schedule

  it('beats CPU sequential and the static baselines', () => {
    expect(adaptive.makespanS).toBeLessThan(c.byPolicy.cpu.schedule.makespanS)
    expect(c.adaptiveSpeedupVsCpu).toBeGreaterThan(1.5)
    expect(c.adaptiveGainVsBestBaseline).toBeGreaterThan(0)
    expect(c.bestPolicy).toBe('adaptive')
  })

  it('places every task exactly once', () => {
    expect(Object.keys(adaptive.decisions).length).toBe(tasks.length)
    for (const task of tasks) {
      const d = adaptive.decisions[task.id]
      expect(d.mode === 'CPU' || d.mode === 'PIM').toBe(true)
      expect(d.endS).toBeGreaterThan(d.startS)
    }
  })

  it('never exceeds the DPU count and uses varied per-task widths', () => {
    const widths = new Set<number>()
    for (const d of Object.values(adaptive.decisions)) {
      if (d.mode !== 'PIM') continue
      expect(d.units.length).toBeGreaterThan(0)
      expect(d.units.length).toBeLessThanOrEqual(8)
      for (const lane of d.units) {
        expect(lane).toBeGreaterThanOrEqual(0)
        expect(lane).toBeLessThan(8)
      }
      widths.add(d.units.length)
    }
    expect(widths.size).toBeGreaterThan(1)
  })

  it('lane busy time never exceeds the makespan', () => {
    for (const lane of adaptive.lanes) {
      expect(lane.busyS).toBeLessThanOrEqual(adaptive.makespanS + 1e-12)
      expect(lane.utilization).toBeLessThanOrEqual(1 + 1e-9)
    }
    expect(adaptive.pimUtilization).toBeGreaterThan(0.5)
  })
})

describe('logical bank allocator', () => {
  const tasks = generateTasks(resident, OPTS)
  const schedule = runSchedule(tasks, resident, 8, 'adaptive')
  const reports = compareAllocators(schedule, tasks, resident, MEM)

  it('bank-aware spreads allocations and cuts conflicts', () => {
    expect(reports['bank-aware'].conflicts).toBeLessThan(reports['first-fit'].conflicts)
    expect(reports['bank-aware'].activeBanks).toBeGreaterThan(reports['first-fit'].activeBanks)
  })

  it('keeps every resident allocation inside the modelled bank capacity', () => {
    for (const bank of reports['bank-aware'].banks) {
      expect(bank.peakBytes).toBeLessThanOrEqual(bank.capacityBytes * 1.01)
    }
  })
})
