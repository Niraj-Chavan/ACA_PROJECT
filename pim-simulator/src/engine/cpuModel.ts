import type { CPUParams, WorkTotals } from './types'

/**
 * Conventional CPU model (Appendix A).
 * T_CPU = max(T_stream + T_random, T_compute): a modern CPU overlaps
 * memory traffic and computation instead of paying for both serially.
 */

export function cpuModel(c: CPUParams, t: WorkTotals) {
  const bytes = t.readBytes + t.writtenBytes
  const streamSeconds = bytes / (c.memBWGBs * 1e9)
  const randomSeconds = (t.randomAccesses * c.memLatencyNs * 1e-9) / (c.cores * c.mlp)
  const memTime = streamSeconds + randomSeconds

  const peakOps = c.cores * c.freqGHz * 1e9 * c.opsPerCycle
  const computeTime = t.ops > 0 ? t.ops / peakOps : 0

  const time = Math.max(memTime, computeTime)
  const bound: 'memory' | 'compute' = computeTime > memTime ? 'compute' : 'memory'

  // cache-line granularity (64 B) for the access count
  const accesses = bytes / 64 + t.randomAccesses

  return { time, memTime, computeTime, bytes, accesses, bound }
}
