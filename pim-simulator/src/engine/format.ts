/** Formatting helpers for time, bytes, energy, speedup. */

export function fmtTime(seconds: number): string {
  if (!isFinite(seconds)) return '∞'
  if (seconds < 1e-6) return `${(seconds * 1e9).toFixed(1)} ns`
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(1)} µs`
  if (seconds < 1) return `${(seconds * 1e3).toFixed(2)} ms`
  return `${seconds.toFixed(2)} s`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`
}

export function fmtEnergy(joules: number): string {
  if (joules < 1e-6) return `${(joules * 1e6).toFixed(2)} µJ`
  if (joules < 1e-3) return `${(joules * 1e3).toFixed(2)} mJ`
  return `${joules.toFixed(3)} J`
}

export function fmtSpeedup(x: number): string {
  return `${x.toFixed(2)}×`
}

export function fmtCount(v: number): string {
  if (v < 1e3) return v.toFixed(0)
  if (v < 1e6) return `${(v / 1e3).toFixed(1)}K`
  if (v < 1e9) return `${(v / 1e6).toFixed(1)}M`
  if (v < 1e12) return `${(v / 1e9).toFixed(2)}B`
  return v.toExponential(2)
}

export function fmtBytesPerSec(bps: number): string {
  return `${fmtBytes(bps)}/s`
}

export function fmtOpsPerSec(ops: number): string {
  return `${fmtCount(ops)} ops/s`
}
