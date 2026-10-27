import type { Params, WorkTotals, Workload } from './types'
import type { PimMid } from './pimModel'
import type { BankUtil } from './types'

/**
 * Per-bank busy percentage (Appendix A).
 *  CPU mode: busy_b = (bytes on bank b ÷ BW_bank) ÷ T_CPU  — banks sit mostly
 *  idle because the shared bus is the bottleneck.
 *  PIM mode: busy_p = T_kernel_p ÷ T_PIM — every unit pumps its own bank, with
 *  visible load imbalance on straggler units.
 */

const MAX_DISPLAY_BINS = 48

function groupAndCap(
  values: { index: number; busyPct: number }[],
  cap: number
): { index: number; busyPct: number }[] {
  if (values.length <= cap) return values
  const grouped: { index: number; busyPct: number }[] = []
  const perBin = Math.ceil(values.length / cap)
  for (let i = 0; i < values.length; i += perBin) {
    let max = 0
    for (let j = i; j < Math.min(i + perBin, values.length); j++) max = Math.max(max, values[j].busyPct)
    grouped.push({ index: i + perBin / 2, busyPct: max })
  }
  return grouped
}

export function computeBankUtilization(
  params: Params,
  t: WorkTotals,
  cpu: { time: number; memTime: number },
  pim: PimMid,
  _n: number
): BankUtil {
  const bytes = t.readBytes + t.writtenBytes
  const bankBWs = params.pim.bankBWGBs * 1e9
  const banks = Math.max(1, Math.round(params.pim.banks))

  // ---- CPU mode: traffic spread across DRAM banks, funnelled over one bus --
  const cpuBusy: { index: number; busyPct: number }[] = []
  const bytesPerBank = bytes / banks
  const busyB = cpu.time > 0 ? ((bytesPerBank / bankBWs) / cpu.time) * 100 : 0
  for (let b = 0; b < banks; b++) {
    // tiny variation across banks (row-buffer locality) to look realistic
    const jitter = 1 + 0.15 * Math.sin((b * 12.9898 * Math.PI) / 180)
    cpuBusy.push({ index: b, busyPct: Math.min(100, Math.max(0, busyB * jitter)) })
  }

  // ---- PIM mode: every unit works on its own slice -------------------------
  const P = pim.P
  const stragglers = Math.max(1, Math.round(P * 0.1))
  const base = pim.time > 0 ? (pim.kernelTime / pim.time) * 100 : 0
  const pimBusy: { index: number; busyPct: number }[] = []
  for (let u = 0; u < P; u++) {
    const isStraggler = u % Math.max(1, Math.floor(P / stragglers)) === 0
    const busy = base * (isStraggler ? 1 + 0.25 : 1)
    pimBusy.push({ index: u, busyPct: Math.min(100, busy) })
  }

  return {
    cpu: groupAndCap(cpuBusy, MAX_DISPLAY_BINS),
    pim: groupAndCap(pimBusy, MAX_DISPLAY_BINS),
  }
}

export type { Workload, Params }
