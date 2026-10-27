import { useEffect, useMemo, useRef, useState } from 'react'
import type { Result } from '../engine/types'
import { fmtTime } from '../engine/format'

/**
 * PhET-style animated datapath. Each phase of the engine timeline becomes a
 * visual phase; short phases are stretched so they stay visible.
 * Respects prefers-reduced-motion by jumping to the final frame.
 */

const PHASE_COLORS: Record<string, string> = {
  stream: 'var(--cpu)',
  overlap: 'var(--cpu-hi)',
  copyIn: 'var(--copy)',
  kernel: 'var(--pim-hi)',
  merge: 'var(--merge)',
  copyOut: 'var(--cout)',
}

const MIN_DURANCE = 0.35 // seconds any phase is shown for visibility

function phaseList(result: Result, side: 'cpu' | 'pim') {
  const raw = result.timeline[side]
  return raw
    .map((p) => ({ ...p, seconds: Math.max(p.seconds, 0) }))
    .filter((p) => p.seconds > 0)
}

export function ArchitectureViz({ result }: { result: Result }) {
  const [progress, setProgress] = useState(0)
  const [running, setRunning] = useState(true)
  const raf = useRef(0)
  const key = `${result.workload}-${result.pim.time}-${result.cpu.time}-${result.units}`
  void key

  const reduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )

  useEffect(() => {
    if (reduced) {
      setProgress(1)
      setRunning(false)
      return
    }
    setRunning(true)
    setProgress(0)
    const start = performance.now()
    const DURATION = 5000 // ms for a full run, stretched for visibility
    const tick = (t: number) => {
      const frac = (t - start) / DURATION
      if (frac >= 1) {
        setProgress(1)
        setRunning(false)
        return
      }
      setProgress(frac)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [key, reduced])

  const cpuPhases = phaseList(result, 'cpu')
  const pimPhases = phaseList(result, 'pim')
  const cpuTotal = cpuPhases.reduce((a, p) => a + Math.max(p.seconds, MIN_DURANCE_SUB), 0)
  const pimTotal = pimPhases.reduce((a, p) => a + Math.max(p.seconds, MIN_DURANCE_SUB), 0)

  // stretch: give every phase at least MIN seconds of animation time
  const stretched = (phases: typeof cpuPhases) => {
    const weights = phases.map((p) => Math.max(p.seconds, MIN_DURANCE_SUB))
    const total = weights.reduce((a, b) => a + b, 0)
    return phases.map((p, i) => ({ ...p, weight: weights[i] / total }))
  }
  const cpuS = stretched(cpuPhases)
  const pimS = stretched(pimPhases)

  const activePhase = (phases: { weight: number }[], kind: 'cpu' | 'pim') => {
    let acc = 0
    const p = progress
    const list = kind === 'cpu' ? cpuS : pimS
    for (let i = 0; i < list.length; i++) {
      acc += list[i].weight
      if (p < acc) return { index: i, local: (p - (acc - list[i].weight)) / list[i].weight }
    }
    return { index: list.length - 1, local: 1 }
  }

  const cpuActive = activePhase(cpuS, 'cpu')
  const pimActive = activePhase(pimS, 'pim')

  const simClock = (side: 'cpu' | 'pim') => {
    const total = side === 'cpu' ? result.cpu.time : result.pim.time
    const list = side === 'cpu' ? cpuS : pimS
    const active = side === 'cpu' ? cpuActive : pimActive
    const phase = list[Math.min(active.index, list.length - 1)]
    const phaseSeconds = phase ? Math.max(phase.seconds, 0) : total
    const done = list.slice(0, active.index).reduce((a, p) => a + p.seconds, 0)
    const frac = running || progress < 1 ? active.local : 1
    return Math.min(done + phaseSeconds * frac, total)
  }

  return (
    <div className="panel arch-viz">
      <h3>Datapath: what actually moves</h3>
      <div className="viz-grid">
        <SidePanel
          side="cpu"
          phases={cpuS}
          active={cpuActive.index}
          progress={cpuActive.local}
          clock={simClock('cpu')}
          total={cpuTotal}
        />
        <SidePanel
          side="pim"
          phases={pimS}
          active={pimActive.index}
          progress={pimActive.local}
          clock={simClock('pim')}
          total={pimTotal}
        />
      </div>
      <div className="viz-legend">
        <span><i style={{ background: 'var(--copy)' }} /> copy-in</span>
        <span><i style={{ background: 'var(--pim-hi)' }} /> PIM compute</span>
        <span><i style={{ background: 'var(--cout)' }} /> copy-out / results</span>
        <span><i style={{ background: 'var(--merge)' }} /> merge partials</span>
        <span><i style={{ background: 'var(--cpu)' }} /> CPU stream</span>
      </div>
      <button className="btn" onClick={() => { setProgress(0); setRunning(true) }}>
        Replay run
      </button>
    </div>
  )
}

const MIN_DURANCE_SUB = 1e-9

function SidePanel({
  side,
  phases,
  active,
  progress,
  clock,
  total,
}: {
  side: 'cpu' | 'pim'
  phases: { name: string; kind: string; seconds: number; weight: number }[]
  active: number
  progress: number
  clock: number
  total: number
}) {
  const phase = phases[Math.min(active, phases.length - 1)]
  const isPim = side === 'pim'
  const showBus = side === 'cpu' || phase?.kind === 'copyIn' || phase?.kind === 'copyOut' || phase?.kind === 'merge'
  const showAllUnits = isPim && phase?.kind === 'kernel'
  return (
    <div className={`viz-side ${isPim ? 'pim' : 'cpu'}`}>
      <div className="viz-title">
        {isPim ? 'PIM system' : 'Conventional CPU'}
        <span className="viz-clock">{fmtTime(clock)} / {fmtTime(total)}</span>
      </div>

      {/* CPU core / command block */}
      <div className="viz-block cpu-core">{isPim ? 'Host CPU (idle)' : 'CPU cores'}</div>

      {/* bus with animated packets */}
      <div className="viz-bus">
        {showBus && (
          <div className="packets" data-kind={phase?.kind}>
            {Array.from({ length: 12 }, (_, i) => {
              const stagger = (progress + i / 12) % 1
              return (
                <span
                  key={i}
                  className="packet"
                  style={{
                    bottom: `${stagger * 100}%`,
                    background: phase ? PHASE_COLORS[phase.kind] : 'var(--cpu)',
                    opacity: 0.25 + 0.75 * Math.sin((i / 12) * Math.PI),
                  }}
                />
              )
            })}
          </div>
        )}
        <div className="bus-label">
          {side === 'cpu' && 'shared bus: every element crosses'}
          {side === 'pim' && phase?.kind === 'copyIn' && 'copy-in over the bus'}
          {side === 'pim' && phase?.kind === 'copyOut' && 'only results cross back'}
          {side === 'pim' && phase?.kind === 'merge' && 'partials merge through host'}
          {side === 'pim' && phase?.kind === 'kernel' && 'bus idle — banks compute locally'}
        </div>
      </div>

      {/* banks */}
      <div className="viz-banks" data-side={side} data-phase={phase?.kind} style={{ ['--p' as never]: progress }}>
        {Array.from({ length: 32 }, (_, i) => {
          const busy = !isPim
            ? side === 'cpu' && phase?.kind === 'stream'
              ? (i % 10 === Math.floor(progress * 10) ? 1 : 0.15)
              : 0.1
            : phase?.kind === 'kernel'
              ? i % 8 === 0 ? 0.95 : 0.8 + 0.15 * Math.cos(i)
              : phase?.kind === 'copyIn' || phase?.kind === 'copyOut' || phase?.kind === 'merge'
                ? 0.35
                : 0.08
          const firing = showAllUnits || (side === 'cpu' && phase?.kind === 'stream')
          return (
            <div
              key={i}
              className={`bank-cell ${busy > 0.5 ? 'busy' : ''} ${firing ? 'firing' : ''}`}
              style={{ opacity: Math.max(0.08, busy) }}
            >
              {isPim && busy > 0.5 ? 'Σ' : ''}
            </div>
          )
        })}
      </div>

      <div className="viz-phase" style={{ color: phase ? PHASE_COLORS[phase.kind] : 'var(--fg)' }}>
        {phase ? phase.name : '—'}
      </div>
    </div>
  )
}
