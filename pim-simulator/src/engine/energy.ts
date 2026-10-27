import type { EnergyParams, EnergyParts, WorkTotals } from './types'
import type { PimMid } from './pimModel'

const PJ = 1e-12 // picojoule → joule

/** Energy models (Appendix A). Returns joules for CPU and PIM runs. */
export function energyModel(
  e: EnergyParams,
  t: WorkTotals,
  cpu: { time: number },
  pim: PimMid
): { cpu: EnergyParts; pim: EnergyParts } {
  const bytes = t.readBytes + t.writtenBytes

  // ---- CPU: every element crosses the off-chip bus -----------------------
  const cpuEnergy: EnergyParts = {
    movement: bytes * e.offchipPJperB * PJ,
    inBank: bytes * e.inbankPJperB * PJ,
    compute: t.ops * e.cpuPJperOp * PJ,
    static: e.cpuStaticW * cpu.time,
  }

  // ---- PIM: only copies cross the bus; element traffic stays in banks ----
  const pimEnergy: EnergyParts = {
    movement: pim.bytesOffchip * e.offchipPJperB * PJ,
    inBank: bytes * e.inbankPJperB * PJ,
    compute: t.ops * pim.c * e.pimPJperOp * PJ,
    static:
      (e.cpuIdleW + pim.P * e.pimUnitW) * pim.time,
  }

  return { cpu: cpuEnergy, pim: pimEnergy }
}

export function energyTotal(parts: EnergyParts): number {
  return parts.movement + parts.inBank + parts.compute + parts.static
}
