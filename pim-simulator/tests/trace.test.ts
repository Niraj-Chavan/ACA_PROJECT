import { describe, it, expect } from 'vitest'
import { defaultParams, upmemPreset } from '../src/engine/params'
import { vectorAdd, reduction, gemv } from '../src/engine/workloads'
import { formulaTrace, traceValue } from '../src/engine/trace'

const byId = (steps: ReturnType<typeof formulaTrace>['steps'], id: string) => {
  const s = steps.find((x) => x.id === id)
  if (!s) throw new Error(`missing trace step ${id}`)
  return s
}

describe('formula trace', () => {
  const n = 16_777_216
  const trace = formulaTrace(defaultParams, vectorAdd, n)

  it('reproduces the aggregate model exactly', () => {
    expect(byId(trace.steps, 'cpu-total').value).toBeCloseTo(trace.result.cpu.time, 12)
    expect(byId(trace.steps, 'pim-total').value).toBeCloseTo(trace.result.pim.time, 12)
    expect(byId(trace.steps, 'speedup').value).toBeCloseTo(trace.result.speedup, 12)
  })

  it('PIM phases sum to T_PIM', () => {
    const sum = ['pim-copyin', 'pim-launch', 'pim-kernel', 'pim-merge', 'pim-copyout', 'pim-sync']
      .map((id) => byId(trace.steps, id).value)
      .reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(trace.pim.time, 12)
  })

  it('marks exactly one dominant leaf per side', () => {
    const cpuDominant = trace.steps.filter((s) => s.group === 'CPU' && s.dominant)
    const pimDominant = trace.steps.filter((s) => s.group === 'PIM' && s.dominant)
    expect(cpuDominant).toHaveLength(1)
    expect(pimDominant).toHaveLength(1)
  })

  it('marks the winning branch of each max()', () => {
    const memoryBound = trace.cpu.computeTime < trace.cpu.memTime
    expect(byId(trace.steps, memoryBound ? 'cpu-mem' : 'cpu-compute').peak).toBe(true)
    expect(byId(trace.steps, memoryBound ? 'cpu-compute' : 'cpu-mem').peak).toBe(false)
  })

  it('resident data makes copy-in free and break-even undefined', () => {
    expect(byId(trace.steps, 'pim-copyin').value).toBe(0)
    expect(trace.result.breakEvenRuns).toBeNull()
    expect(byId(trace.steps, 'breakeven').unit).toBe('runs')
  })

  it('op-mix correction is 1 for pure-add and >1 for GEMV on UPMEM', () => {
    const addTrace = formulaTrace(upmemPreset, vectorAdd, n)
    expect(byId(addTrace.steps, 'pim-c').value).toBeCloseTo(1, 6)
    const gemvTrace = formulaTrace(upmemPreset, gemv, n)
    expect(byId(gemvTrace.steps, 'pim-c').value).toBeGreaterThan(1)
  })

  it('reduction exposes a non-zero merge term', () => {
    const r = formulaTrace(upmemPreset, reduction, n)
    expect(byId(r.steps, 'pim-merge').value).toBeGreaterThan(0)
  })

  it('formats each unit sensibly', () => {
    expect(traceValue(byId(trace.steps, 'cpu-total'))).toMatch(/ns|µs|ms|s/)
    expect(traceValue(byId(trace.steps, 'speedup'))).toMatch(/×/)
    expect(traceValue(byId(trace.steps, 'pim-c'))).toMatch(/×/)
  })
})
