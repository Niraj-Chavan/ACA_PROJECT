import type { Params, Result, Workload } from './types'
import { simulate } from './simulate'

export type SweepParam =
  | 'dataSize'
  | 'pimUnits'
  | 'cpuMemBWGBs'
  | 'memLatencyNs'
  | 'pimFreqGHz'
  | 'mulCost'
  | 'runsResident'

export interface SweepRow {
  sweepValue: number
  cpuTime: number
  pimTime: number
  speedup: number
  cpuBytes: number
  pimOffchipBytes: number
  cpuEnergy: number
  pimEnergy: number
  energySavingPct: number
  cpuThroughput: number
  pimThroughput: number
}

/** log-spaced values from a to b, count points */
export function logspace(a: number, b: number, count: number): number[] {
  const la = Math.log10(a)
  const lb = Math.log10(b)
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(Math.pow(10, la + ((lb - la) * i) / (count - 1)))
  return out
}

function simulateWithOverrides(params: Params, workload: Workload, n: number): Result {
  return simulate(params, workload, n)
}

export function applySweepValue(
  params: Params,
  key: SweepParam,
  value: number
): { params: Params; n: number } {
  const p: Params = JSON.parse(JSON.stringify(params))
  let n = value
  switch (key) {
    case 'dataSize':
      // value = total data bytes; n = elements of 4 bytes
      n = Math.max(64, Math.round(value / 4))
      break
    case 'pimUnits':
      p.pim.unitsPerBank = 1
      p.pim.banks = Math.max(1, Math.round(value))
      n = 33554432
      break
    case 'cpuMemBWGBs':
      p.cpu.memBWGBs = value
      break
    case 'memLatencyNs':
      p.cpu.memLatencyNs = value
      n = 33554432
      break
    case 'pimFreqGHz':
      p.pim.freqGHz = value
      break
    case 'mulCost':
      p.pim.mulCost = value
      break
    case 'runsResident': {
      // value = run index; runs after the first find data already resident
      n = 33554432
      break
    }
  }
  return { params: p, n }
}

export function sweep(
  params: Params,
  workload: Workload,
  key: SweepParam,
  values: number[],
  opts?: { respectDataResidentRun?: boolean }
): SweepRow[] {
  const rows: SweepRow[] = []
  for (const v of values) {
    const { params: p, n } = applySweepValue(params, key, v)
    const base = simulateWithOverrides(p, workload, n)
    let speedup = base.speedup
    let cpuTime = base.cpu.time
    let pimTime = base.pim.time
    let pimEnergy = base.pim.energy.movement + base.pim.energy.inBank + base.pim.energy.compute + base.pim.energy.static
    let pimThroughput = base.pim.throughput
    let pimOffchip = base.pim.bytesOffchip

    if (key === 'runsResident') {
      // run 1 pays copy-in; later runs find data resident
      const first = opts?.respectDataResidentRun ? simulateResidentRun(p, workload, n, false) : null
      if (first && v < 2) {
        cpuTime = first.cpuTime
        pimTime = first.pimTime
        speedup = first.speedup
        pimEnergy = first.pimEnergy
        pimThroughput = first.pimThroughput
        pimOffchip = first.pimOffchip
      } else {
        const resident = simulateResidentRun(p, workload, n, true)
        if (resident) {
          pimTime = resident.pimTime
          speedup = resident.speedup
          pimEnergy = resident.pimEnergy
          pimThroughput = resident.pimThroughput
          pimOffchip = resident.pimOffchip
        }
      }
    }

    const cpuEnergy =
      base.cpu.energy.movement + base.cpu.energy.inBank + base.cpu.energy.compute + base.cpu.energy.static
    rows.push({
      sweepValue: v,
      cpuTime,
      pimTime,
      speedup,
      cpuBytes: base.cpu.bytes,
      pimOffchipBytes: pimOffchip,
      cpuEnergy,
      pimEnergy,
      energySavingPct: cpuEnergy > 0 ? ((cpuEnergy - pimEnergy) / cpuEnergy) * 100 : 0,
      cpuThroughput: base.cpu.throughput,
      pimThroughput,
    })
  }
  return rows
}

function simulateResidentRun(
  params: Params,
  workload: Workload,
  n: number,
  resident: boolean
): { cpuTime: number; pimTime: number; speedup: number; pimEnergy: number; pimThroughput: number; pimOffchip: number } | null {
  const p: Params = JSON.parse(JSON.stringify(params))
  p.dataResident = resident
  const r = simulate(p, workload, n)
  return {
    cpuTime: r.cpu.time,
    pimTime: r.pim.time,
    speedup: r.speedup,
    pimEnergy:
      r.pim.energy.movement + r.pim.energy.inBank + r.pim.energy.compute + r.pim.energy.static,
    pimThroughput: r.pim.throughput,
    pimOffchip: r.pim.bytesOffchip,
  }
}

/** CSV export from sweep rows */
export function rowsToCsv(rows: SweepRow[], sweepLabel: string): string {
  const header =
    `${sweepLabel},cpu_time_s,pim_time_s,speedup,cpu_bytes,pim_offchip_bytes,cpu_energy_J,pim_energy_J,energy_saving_pct,cpu_throughput_ops_s,pim_throughput_ops_s`
  const lines = rows.map((r) =>
    [
      r.sweepValue,
      r.cpuTime,
      r.pimTime,
      r.speedup.toFixed(4),
      r.cpuBytes,
      r.pimOffchipBytes,
      r.cpuEnergy.toExponential(6),
      r.pimEnergy.toExponential(6),
      r.energySavingPct.toFixed(2),
      r.cpuThroughput.toExponential(6),
      r.pimThroughput.toExponential(6),
    ].join(',')
  )
  return [header, ...lines].join('\n')
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
