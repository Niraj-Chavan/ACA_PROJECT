import type { Params, Workload } from './types'
import { simulate } from './simulate'

/**
 * Configuration optimiser (Phase 6B).
 * Search space: banks {1 … 4096} × units/bank {1, 2, 4} × PIM freq
 * {0.35, 0.5, 1.0, 1.5} GHz, under a power budget. Objectives:
 * minimum time, minimum energy, or minimum energy × delay (ED).
 */

export interface OptimizerCandidate {
  banks: number
  unitsPerBank: number
  freqGHz: number
  powerW: number
  timeS: number
  energyJ: number
  ed: number
  speedup: number
  energySavingPct: number
}

export type Objective = 'time' | 'energy' | 'ed'

export interface OptimizerResult {
  recommended: OptimizerCandidate | null
  candidates: OptimizerCandidate[]
  pareto: OptimizerCandidate[]
  inBudget: number
  message: string
}

const BANK_GRID = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]
const UPB_GRID = [1, 2, 4]
const FREQ_GRID = [0.35, 0.5, 1.0, 1.5]

export function optimize(
  params: Params,
  workload: Workload,
  n: number,
  objective: Objective,
  powerBudgetW: number
): OptimizerResult {
  const candidates: OptimizerCandidate[] = []
  let inBudget = 0
  let winsForPim = false
  let losses = 0

  for (const banks of BANK_GRID) {
    for (const upb of UPB_GRID) {
      for (const freq of FREQ_GRID) {
        const p: Params = JSON.parse(JSON.stringify(params))
        p.pim.banks = banks
        p.pim.unitsPerBank = upb
        p.pim.freqGHz = freq
        const units = banks * upb
        const powerW = params.energy.cpuIdleW + units * params.energy.pimUnitW
        if (powerW > powerBudgetW) continue
        inBudget++

        const r = simulate(p, workload, n)
        const ce =
          r.cpu.energy.movement + r.cpu.energy.inBank + r.cpu.energy.compute + r.cpu.energy.static
        const pe =
          r.pim.energy.movement + r.pim.energy.inBank + r.pim.energy.compute + r.pim.energy.static
        candidates.push({
          banks,
          unitsPerBank: upb,
          freqGHz: freq,
          powerW,
          timeS: r.pim.time,
          energyJ: pe,
          ed: pe * r.pim.time,
          speedup: r.speedup,
          energySavingPct: ce > 0 ? ((ce - pe) / ce) * 100 : 0,
        })
        if (r.speedup > 1) winsForPim = true
        else losses++
      }
    }
  }

  let recommended: OptimizerCandidate | null = null
  if (objective === 'time' && candidates.length > 0) {
    recommended = candidates.reduce((a, b) => (b.timeS < a.timeS ? b : a))
  } else if (objective === 'energy' && candidates.length > 0) {
    recommended = candidates.reduce((a, b) => (b.energyJ < a.energyJ ? b : a))
  } else if (candidates.length > 0) {
    recommended = candidates.reduce((a, b) => (b.ed < a.ed ? b : a))
  }

  // Pareto front on (time, energy): non-dominated points
  const pareto = candidates
    .slice()
    .sort((a, b) => a.timeS - b.timeS)
    .filter((c) => {
      const dominated = candidates.some(
        (o) => o !== c && o.timeS <= c.timeS && o.energyJ <= c.energyJ &&
              (o.timeS < c.timeS || o.energyJ < c.energyJ)
      )
      return !dominated
    })

  const message = !recommended
    ? 'No configuration fits the power budget — raise the budget.'
    : !winsForPim
      ? `No PIM configuration beats the CPU for ${workload.short} (GEMM-style compute-bound work). Best PIM config is still ${(recommended.speedup).toFixed(2)}×.`
      : `Recommended: ${recommended.banks} banks × ${recommended.unitsPerBank} units at ${recommended.freqGHz} GHz → ${recommended.speedup.toFixed(2)}× speedup, ${recommended.energySavingPct.toFixed(0)}% less energy (${losses > 0 ? 'some configurations lose; ' : ''}power ${(recommended.powerW).toFixed(2)} W).`

  return { recommended, candidates, pareto, inBudget, message }
}
