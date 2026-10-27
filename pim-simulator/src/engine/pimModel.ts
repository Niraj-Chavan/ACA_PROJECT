import type { PIMParams, WorkTotals, Result } from './types'

/**
 * PIM model (Appendix A). Also models the costs PIM marketing usually
 * leaves out: copy-in of non-resident data, merging partial results
 * through the host, copy-out, launch and sync overhead, load imbalance.
 * In-bank random access latency assumed ≈ 60 ns (model assumption).
 */

const INBANK_RANDOM_NS = 60
const HOST_MERGE_RATE = 2e9 // host merges partials at ~2 Gops/s (assumption)

export interface PimMid {
  P: number
  time: number
  kernelTime: number
  bankTime: number
  computeTime: number
  mergeTime: number
  copyIn: number
  kernel: number
  copyOut: number
  launch: number
  sync: number
  copyInBytes: number
  copyOutBytes: number
  partials: number
  bytesOffchip: number
  mulFrac: number
  c: number
  bound: Result['pim']['bound']
}

export function pimModel(
  p: PIMParams,
  t: WorkTotals,
  opts: { dataResident: boolean; resultNeededOnHost: boolean },
  n: number,
  imbalance: number
): PimMid {
  const P = Math.max(1, Math.round(p.banks * p.unitsPerBank))

  // ---- copy-in --------------------------------------------------------
  const copyInBytes = opts.dataResident ? 0 : t.inputBytes
  const copyIn = copyInBytes / (p.copyBWGBs * 1e9)

  // ---- kernel: each unit processes n/P elements -----------------------
  const workElems = (n / P) * imbalance
  const kernelBytes = ((t.readBytes + t.writtenBytes) / Math.max(n, 1)) * workElems
  const bankTime =
    kernelBytes / (p.bankBWGBs * 1e9) +
    (t.randomAccesses / P) * INBANK_RANDOM_NS * 1e-9
  const mulFrac = t.ops > 0 ? t.mulOps / t.ops : 0
  const c = 1 - mulFrac + mulFrac * p.mulCost
  const kernelOps = (t.ops / Math.max(n, 1)) * workElems
  const computeTime = (kernelOps * c) / (p.freqGHz * 1e9 * p.opsPerCycle)
  const kernel = Math.max(bankTime, computeTime)

  // ---- merge of partials through the host ------------------------------
  const partials = P * t.partialBytesPerUnit
  const mergeBytesTime = partials / (p.copyBWGBs * 1e9)
  const mergeOpsTime = (P * t.mergeOpsPerUnit) / HOST_MERGE_RATE
  const merge = mergeBytesTime + mergeOpsTime

  // ---- copy-out ---------------------------------------------------------
  const copyOutBytes = opts.resultNeededOnHost ? t.outputBytes : 0
  const copyOut = copyOutBytes / (p.copyBWGBs * 1e9)

  // ---- overheads ---------------------------------------------------------
  const launch = p.launchUs * 1e-6
  const sync = t.syncs * p.syncUs * 1e-6

  const time = copyIn + launch + kernel + merge + copyOut + sync
  const bytesOffchip = copyInBytes + copyOutBytes + partials

  const bound: Result['pim']['bound'] =
    copyIn + copyOut >= time / 2 && copyInBytes + copyOutBytes > 0
      ? 'copy'
      : merge + sync >= time / 2
        ? 'communication'
        : launch + mergeBytesTime === 0 && computeTime < bankTime
          ? 'bank'
          : computeTime > bankTime
            ? 'compute'
            : 'bank'

  return {
    P,
    time,
    kernelTime: kernel,
    bankTime,
    computeTime,
    mergeTime: merge,
    copyIn,
    kernel,
    copyOut,
    launch,
    sync,
    copyInBytes,
    copyOutBytes,
    partials,
    bytesOffchip,
    mulFrac,
    c,
    bound,
  }
}
