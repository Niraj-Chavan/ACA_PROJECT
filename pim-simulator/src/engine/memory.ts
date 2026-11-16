import type { Params } from './types'
import type { Task } from './tasks'
import type { Schedule } from './scheduler'

/**
 * Modelled logical bank allocator.
 *
 * UPMEM's host API exposes DPUs (`dpu_alloc`), not physical bank placement, so
 * this allocator is a *model* used to reason about bank conflicts and
 * fragmentation. It does not program a real bank map.
 *
 * Layout: each DPU has 16 logical bank segments of `capacityBytes`. Tasks get
 * a contiguous span in a bank for their resident buffer. A bank conflict is
 * counted when two task lifetimes overlap in the same bank.
 */

export type AllocPolicy = 'first-fit' | 'best-fit' | 'bank-aware'

export interface AllocPolicyInfo {
  id: AllocPolicy
  label: string
  description: string
}

export const ALLOC_POLICIES: AllocPolicyInfo[] = [
  {
    id: 'first-fit',
    label: 'First Fit',
    description: 'Scan banks from 0 and take the first one with room. Fast, but it packs concurrent tasks into the same bank.',
  },
  {
    id: 'best-fit',
    label: 'Best Fit',
    description: 'Pick the tightest bank that still fits, so little capacity is wasted — but lifetimes are still ignored.',
  },
  {
    id: 'bank-aware',
    label: 'Bank-aware',
    description: 'Prefer banks whose resident tasks do not overlap this task in time, then spread across banks. Trades per-bank fragmentation for fewer conflicts.',
  },
]

export interface MemoryOptions {
  banksPerDpu?: number
  capacityBytes?: number
}

export interface MemBlock {
  taskId: number
  taskKey: string
  kind: string
  lane: number
  bank: number
  startS: number
  endS: number
  bytes: number
  offsetBytes: number
}

export interface BankUse {
  lane: number
  bank: number
  blocks: MemBlock[]
  peakBytes: number
  capacityBytes: number
  peakPct: number
  conflicts: number
  conflictS: number
}

export interface MemoryReport {
  policy: AllocPolicy
  banksPerDpu: number
  capacityBytes: number
  dpus: number
  blocks: MemBlock[]
  banks: BankUse[]
  conflicts: number
  conflictS: number
  /** highest instantaneous use of any bank, 0..1 */
  peakPct: number
  activeBanks: number
  totalBanks: number
  /** idle banks / all banks — external fragmentation of the bank set */
  idleBankPct: number
  /** unused capacity inside active banks at their peak — internal fragmentation */
  internalFragPct: number
  allocatedBytes: number
}

/** Each logical MRAM bank is modelled as a 64 KiB part. */
const PART_BYTES = 64 * 1024

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))

/** Peak concurrent bytes for one bank from its block lifetimes. */
function bankPeakBytes(blocks: MemBlock[]): number {
  const events: { t: number; delta: number }[] = []
  for (const b of blocks) {
    events.push({ t: b.startS, delta: b.bytes })
    events.push({ t: b.endS, delta: -b.bytes })
  }
  events.sort((a, b) => a.t - b.t || b.delta - a.delta)
  let current = 0
  let peak = 0
  for (const e of events) {
    current += e.delta
    peak = Math.max(peak, current)
  }
  return peak
}

export function allocateMemory(
  schedule: Schedule,
  tasks: Task[],
  params: Params,
  policy: AllocPolicy,
  opts: MemoryOptions = {}
): MemoryReport {
  const banksPerDpu = Math.max(1, Math.floor(opts.banksPerDpu ?? 16))
  const capacityBytes = Math.max(1, Math.floor(opts.capacityBytes ?? PART_BYTES))
  const partBytesBase = Math.min(PART_BYTES, capacityBytes)
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const banks: BankUse[] = []

  for (let lane = 0; lane < schedule.dpus; lane++) {
    for (let bank = 0; bank < banksPerDpu; bank++) {
      banks.push({
        lane,
        bank,
        blocks: [],
        peakBytes: 0,
        capacityBytes,
        peakPct: 0,
        conflicts: 0,
        conflictS: 0,
      })
    }
  }

  const reportBlocks: MemBlock[] = []

  for (let lane = 0; lane < schedule.dpus; lane++) {
    const laneIntervals = schedule.intervals
      .filter((i) => i.lane === lane)
      .sort((a, b) => a.startS - b.startS || a.endS - b.endS || a.taskId - b.taskId)

    for (const interval of laneIntervals) {
      const task = taskById.get(interval.taskId)
      if (!task) continue
      const units = Math.max(1, interval.units.length)
      const bytesPerUnit = task.bytes / units
      // Resident data is pre-loaded at t = 0 and held until the task finishes.
      // Cold data lives only for the task window.
      const startS = params.dataResident ? 0 : interval.startS
      const endS = interval.endS
      const parts = Math.max(1, Math.ceil(bytesPerUnit / partBytesBase))

      for (let part = 0; part < parts; part++) {
        const partBytes =
          part === parts - 1 ? bytesPerUnit - partBytesBase * (parts - 1) : partBytesBase
        let chosen = -1
        let chosenScore = Number.POSITIVE_INFINITY

        for (let bank = 0; bank < banksPerDpu; bank++) {
          const entry = banks[lane * banksPerDpu + bank]
          let usedBytes = 0
          let overlapTasks = new Set<number>()
          for (const b of entry.blocks) {
            const ov = overlap(startS, endS, b.startS, b.endS)
            if (ov > 0) {
              usedBytes += b.bytes
              if (b.taskId !== task.id) overlapTasks.add(b.taskId)
            }
          }
          if (usedBytes + partBytes > capacityBytes + 1e-9) continue

          let score: number
          if (policy === 'first-fit') {
            // pack from bank 0, ignore who else is resident
            score = bank
          } else if (policy === 'best-fit') {
            // tightest remaining room: fill the most-used bank that still fits
            score = -(usedBytes + partBytes) + bank * 1e-6
          } else {
            // bank-aware: avoid sharing a bank with a resident task, then spread
            score = overlapTasks.size * 1e6 + usedBytes + bank * 1e-9
          }
          if (score < chosenScore) {
            chosenScore = score
            chosen = bank
          }
        }

        // Fallback: the bank with the fewest resident tasks, then least bytes.
        if (chosen < 0) {
          let bestTasks = Number.POSITIVE_INFINITY
          let bestBytes = Number.POSITIVE_INFINITY
          for (let bank = 0; bank < banksPerDpu; bank++) {
            const entry = banks[lane * banksPerDpu + bank]
            const resident = new Set(
              entry.blocks
                .filter((b) => overlap(startS, endS, b.startS, b.endS) > 0)
                .map((b) => b.taskId)
            )
            const used = entry.blocks.reduce(
              (a, b) => a + (overlap(startS, endS, b.startS, b.endS) > 0 ? b.bytes : 0),
              0
            )
            if (resident.size < bestTasks || (resident.size === bestTasks && used < bestBytes)) {
              bestTasks = resident.size
              bestBytes = used
              chosen = bank
            }
          }
          chosen = Math.max(0, chosen)
        }

        const entry = banks[lane * banksPerDpu + chosen]
        const offsetBytes = entry.blocks
          .filter((b) => overlap(startS, endS, b.startS, b.endS) > 0)
          .reduce((a, b) => a + b.bytes, 0)
        const block: MemBlock = {
          taskId: task.id,
          taskKey: task.key,
          kind: task.kind,
          lane,
          bank: chosen,
          startS,
          endS,
          bytes: partBytes,
          offsetBytes,
        }
        entry.blocks.push(block)
        reportBlocks.push(block)
      }
    }
  }

  let conflicts = 0
  let conflictS = 0
  let peakPct = 0
  let activeBanks = 0
  let fragSum = 0

  for (const entry of banks) {
    entry.peakBytes = bankPeakBytes(entry.blocks)
    entry.peakPct = entry.peakBytes / capacityBytes
    peakPct = Math.max(peakPct, entry.peakPct)
    if (entry.blocks.length > 0) {
      activeBanks += 1
      fragSum += Math.max(0, 1 - entry.peakPct)
    }
    // Conflicts are task pairs sharing a bank while both are resident.
    // Group parts by task first so one pair is counted once per bank.
    const byTask = new Map<number, { startS: number; endS: number }>()
    for (const b of entry.blocks) {
      const prev = byTask.get(b.taskId)
      if (!prev) byTask.set(b.taskId, { startS: b.startS, endS: b.endS })
      else {
        prev.startS = Math.min(prev.startS, b.startS)
        prev.endS = Math.max(prev.endS, b.endS)
      }
    }
    const resident = [...byTask.values()]
    for (let i = 0; i < resident.length; i++) {
      for (let j = i + 1; j < resident.length; j++) {
        const ov = overlap(
          resident[i].startS,
          resident[i].endS,
          resident[j].startS,
          resident[j].endS
        )
        if (ov > 0) {
          entry.conflicts += 1
          entry.conflictS += ov
          conflicts += 1
          conflictS += ov
        }
      }
    }
  }

  const totalBanks = schedule.dpus * banksPerDpu
  return {
    policy,
    banksPerDpu,
    capacityBytes,
    dpus: schedule.dpus,
    blocks: reportBlocks,
    banks,
    conflicts,
    conflictS,
    peakPct,
    activeBanks,
    totalBanks,
    idleBankPct: totalBanks > 0 ? 1 - activeBanks / totalBanks : 0,
    internalFragPct: activeBanks > 0 ? fragSum / activeBanks : 0,
    allocatedBytes: reportBlocks.reduce((a, b) => a + b.bytes, 0),
  }
}

/** All three policies for the same schedule, for the Memory sub-view. */
export function compareAllocators(
  schedule: Schedule,
  tasks: Task[],
  params: Params,
  opts: MemoryOptions = {}
): Record<AllocPolicy, MemoryReport> {
  return {
    'first-fit': allocateMemory(schedule, tasks, params, 'first-fit', opts),
    'best-fit': allocateMemory(schedule, tasks, params, 'best-fit', opts),
    'bank-aware': allocateMemory(schedule, tasks, params, 'bank-aware', opts),
  }
}
