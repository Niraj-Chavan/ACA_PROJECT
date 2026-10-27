import { describe, it, expect } from 'vitest'
import { defaultParams, presets } from '../src/engine/params'
import { allWorkloads, workloadById, vectorAdd, reduction, gemm } from '../src/engine/workloads'
import { simulate } from '../src/engine/simulate'
import { fmtTime, fmtBytes, fmtEnergy, fmtSpeedup } from '../src/engine/format'
import { energyTotal } from '../src/engine/energy'

const tol = (a: number, b: number, pct = 1) => Math.abs(a - b) <= (b * pct) / 100

describe('Phase 1 worked example (Vector Add, mockup defaults, n = 134,217,728)', () => {
  const n = 134_217_728
  const r = simulate(defaultParams, vectorAdd, n)

  it('CPU bytes moved ≈ 1.61 GB', () => {
    expect(tol(r.cpu.bytes, 12 * n)).toBe(true)
    expect(r.cpu.bytes).toBeCloseTo(1.609e9, -7)
  })

  it('CPU memory time ≈ 64.4 ms and compute time ≈ 1.2 ms', () => {
    expect(tol(r.cpu.memTime, 1.609e9 / 25e9)).toBe(true)
    expect(tol(r.cpu.computeTime, n / (8 * 3.5e9 * 4))).toBe(true)
  })

  it('T_CPU = max(64.4, 1.2) = 64.4 ms (memory-bound)', () => {
    expect(tol(r.cpu.time, 64.4e-3)).toBe(true)
    expect(r.cpu.bound).toBe('memory')
  })

  it('T_PIM resident ≈ 25.2–25.3 ms → speedup ≈ 2.56×', () => {
    expect(tol(r.pim.kernel, (12 * n) / 8 / 8e9)).toBe(true)
    expect(tol(r.pim.time, 25.2e-3 + 50e-6, 2)).toBe(true)
    expect(tol(r.speedup, 2.56, 2)).toBe(true)
  })

  it('copy-in + copy-out adds ≈ 64.4 ms → speedup ≈ 0.72× (PIM loses)', () => {
    const p2 = JSON.parse(JSON.stringify(defaultParams))
    p2.dataResident = false
    p2.resultNeededOnHost = true // worked example includes copy-out 21.5 ms
    const r2 = simulate(p2, vectorAdd, n)
    expect(tol(r2.pim.time, 89.6e-3, 3)).toBe(true)
    expect(tol(r2.speedup, 0.72, 3)).toBe(true)
    expect(r2.breakEvenRuns).not.toBeNull()
    expect(tol(r2.breakEvenRuns as number, 1.64, 5)).toBe(true)
  })

  it('energies: CPU movement ≈ 0.26 J, PIM in-bank ≈ 0.04 J', () => {
    expect(tol(r.cpu.energy.movement, 1.609e9 * 160e-12)).toBe(true)
    expect(tol(r.pim.energy.inBank, 1.609e9 * 25e-12, 2)).toBe(true)
  })
})

describe('Phase 2 sanity tests', () => {
  const n = 16_777_216

  it('doubling data size roughly doubles both T_CPU and T_PIM (streaming)', () => {
    const a = simulate(defaultParams, vectorAdd, n)
    const b = simulate(defaultParams, vectorAdd, 2 * n)
    const r1 = a.cpu.time
    const r2 = b.cpu.time
    expect(r2 / r1).toBeGreaterThan(1.8)
    expect(r2 / r1).toBeLessThan(2.2)
  })

  it('with 1 PIM unit, PIM time ≈ serial time of one unit', () => {
    const p = JSON.parse(JSON.stringify(defaultParams))
    p.pim.banks = 1
    p.pim.unitsPerBank = 1
    p.dataResident = false
    p.resultNeededOnHost = true
    const r = simulate(p, vectorAdd, n)
    // copy-in + kernel + copy-out, serialised through a single unit
    const manual = (8 * n) / 25e9 + (12 * n) / 8e9 + (4 * n) / 25e9 + 50e-6
    expect(tol(r.pim.time, manual, 1)).toBe(true)
    // kernel alone should equal the whole array traffic on one unit
    expect(tol(r.pim.kernel, (12 * n) / 8e9)).toBe(true)
  })

  it('turning off "data resident" adds exactly input_bytes ÷ copy BW', () => {
    const rRes = simulate(defaultParams, vectorAdd, n)
    const p2 = JSON.parse(JSON.stringify(defaultParams))
    p2.dataResident = false
    const rCopy = simulate(p2, vectorAdd, n)
    const expected = (8 * n) / 25e9
    expect(tol(rCopy.pim.time - rRes.pim.time, expected, 0.1)).toBe(true)
  })

  it('GEMM is faster on the CPU with the default preset', () => {
    const r = simulate(defaultParams, gemm, Math.pow(2, 24))
    expect(r.speedup).toBeLessThan(1)
  })

  it('reduction speedup stops growing at high unit counts (merge cost)', () => {
    const p = JSON.parse(JSON.stringify(defaultParams))
    p.pim.banks = 8
    const lo = simulate(p, reduction, n)
    p.pim.banks = 4096
    const hi = simulate(p, reduction, n)
    const idealGain = 4096 / 8
    expect(hi.speedup / lo.speedup).toBeLessThan(idealGain * 0.5)
  })

  it('every workload gives finite, positive outputs across slider ranges', () => {
    for (const preset of Object.values(presets)) {
      for (const w of allWorkloads) {
        for (const banks of [1, 4, 256, 4096]) {
          for (const dataBytes of [1024, 1024 ** 2, 1024 ** 3]) {
            const p = JSON.parse(JSON.stringify(preset))
            p.pim.banks = banks
            p.dataResident = banks % 2 === 0
            const r = simulate(p, w, Math.max(64, Math.round(dataBytes / 4)))
            const all = [
              r.cpu.time, r.pim.time, r.speedup, r.cpu.bytes, r.pim.bytesOffchip,
              energyTotal(r.cpu.energy), energyTotal(r.pim.energy),
              r.cpu.throughput, r.pim.throughput, r.arithmeticIntensity,
            ]
            for (const v of all) {
              expect(Number.isFinite(v)).toBe(true)
              expect(v).toBeGreaterThanOrEqual(0)
            }
          }
        }
      }
    }
  })

  it('energy saving = (E_CPU − E_PIM) ÷ E_CPU × 100', () => {
    const r = simulate(defaultParams, vectorAdd, n)
    const ec = energyTotal(r.cpu.energy)
    const ep = energyTotal(r.pim.energy)
    expect(tol(r.energySaving, ((ec - ep) / ec) * 100)).toBe(true)
  })

  it('formatters do not produce NaN', () => {
    expect(fmtTime(64.4e-3)).toBe('64.40 ms')
    expect(fmtBytes(1.61e9)).toBe('1.50 GB')
    expect(fmtEnergy(0.26)).toBe('0.260 J')
    expect(fmtEnergy(2.6e-4)).toBe('0.26 mJ')
    expect(fmtSpeedup(2.556)).toBe('2.56×')
  })
})

describe('console results table (all workloads)', () => {
  it('prints a table', () => {
    const rows = allWorkloads.map((w) => {
      const r = simulate(defaultParams, workloadById(w.id), 33_554_432)
      return `${w.short.padEnd(10)} CPU ${fmtTime(r.cpu.time).padEnd(10)} PIM ${fmtTime(r.pim.time).padEnd(10)} speedup ${fmtSpeedup(r.speedup).padEnd(8)} energy saving ${r.energySaving.toFixed(1)}%`
    })
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n')
    expect(rows.length).toBe(8)
  })
})
