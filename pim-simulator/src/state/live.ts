import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Live / replay run state.
 *
 * The bridge (bridge/server.mjs) spawns a real kernel build+run and forwards
 * every JSON line the host emits on stderr as an SSE message. A run can also
 * be replayed from a saved .jsonl file, which is how the demo works offline.
 */

export interface RunMeta {
  event: 'meta'
  kernel: string
  dpus: number
  tasklets: number
  n: number
  ops: number
}

export interface PhaseEvent {
  event: 'phase'
  name: string
  ms: number
  bytes: number
}

export interface DpuEvent {
  event: 'dpu'
  cycles: number
  dpus: number
}

export interface DoneEvent {
  event: 'done'
  ok?: boolean
  code?: number
  saved?: string
}

export type RunEvent = RunMeta | PhaseEvent | DpuEvent | DoneEvent | { event: string }

export type RunSource = 'idle' | 'live' | 'replay'

export interface RunState {
  meta: RunMeta | null
  phases: PhaseEvent[]
  dpu: DpuEvent | null
  done: DoneEvent | null
  events: RunEvent[]
  totalMs: number
  running: boolean
  source: RunSource
  error: string | null
}

export const EMPTY_RUN: RunState = {
  meta: null,
  phases: [],
  dpu: null,
  done: null,
  events: [],
  totalMs: 0,
  running: false,
  source: 'idle',
  error: null,
}

/** Parse JSON-lines; blank and non-JSON lines (make/SDK chatter) are ignored. */
export function parseEventLines(text: string): RunEvent[] {
  const events: RunEvent[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as RunEvent
      if (parsed && typeof parsed === 'object' && typeof (parsed as { event?: unknown }).event === 'string') {
        events.push(parsed)
      }
    } catch {
      // a truncated line while the kernel is still writing: skip it
    }
  }
  return events
}

export function reduceRun(events: RunEvent[], base: Partial<RunState> = {}): RunState {
  const state: RunState = { ...EMPTY_RUN, ...base, phases: [] }
  for (const event of events) {
    if (event.event === 'meta') {
      state.meta = event as RunMeta
    } else if (event.event === 'phase') {
      state.phases = [...state.phases, event as PhaseEvent]
    } else if (event.event === 'dpu') {
      state.dpu = event as DpuEvent
    } else if (event.event === 'done') {
      state.done = event as DoneEvent
      state.running = false
    }
    state.events = [...state.events, event]
  }
  state.totalMs = state.phases.reduce((a, p) => a + p.ms, 0)
  return state
}

/** Append one event with the same reducer semantics as a full replay. */
export function appendEvent(state: RunState, event: RunEvent): RunState {
  const next: RunState = {
    ...state,
    phases: event.event === 'phase' ? [...state.phases, event as PhaseEvent] : state.phases,
    events: [...state.events, event],
  }
  if (event.event === 'meta') next.meta = event as RunMeta
  if (event.event === 'dpu') next.dpu = event as DpuEvent
  if (event.event === 'done') {
    next.done = event as DoneEvent
    next.running = false
  }
  next.totalMs = next.phases.reduce((a, p) => a + p.ms, 0)
  return next
}

export const BRIDGE_URL =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BRIDGE_URL ?? 'http://localhost:8787'

export interface LiveRunApi {
  state: RunState
  start: (kernel: string, dpus: number) => void
  stop: () => void
  replay: (text: string, label?: string) => void
  clear: () => void
}

export function useLiveRun(): LiveRunApi {
  const [state, setState] = useState<RunState>(EMPTY_RUN)
  const sourceRef = useRef<EventSource | null>(null)

  const stop = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    setState((s) => ({ ...s, running: false }))
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(
    (kernel: string, dpus: number) => {
      stop()
      setState({ ...EMPTY_RUN, source: 'live', running: true })
      const url = `${BRIDGE_URL}/api/run?kernel=${encodeURIComponent(kernel)}&dpus=${dpus}`
      const es = new EventSource(url)
      sourceRef.current = es
      es.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as RunEvent
          setState((s) => appendEvent(s, event))
        } catch {
          // ignore malformed frame
        }
      }
      es.addEventListener('done', () => {
        es.close()
        sourceRef.current = null
        setState((s) => ({ ...s, running: false }))
      })
      es.onerror = () => {
        es.close()
        sourceRef.current = null
        setState((s) =>
          s.events.length > 0
            ? { ...s, running: false }
            : {
                ...s,
                running: false,
                error: `No bridge at ${BRIDGE_URL}. Start it with: node bridge/server.mjs`,
              }
        )
      }
    },
    [stop]
  )

  const replay = useCallback((text: string, label = 'replay') => {
    stop()
    const events = parseEventLines(text)
    if (!events.length) {
      setState({ ...EMPTY_RUN, error: `No JSON events found in ${label}` })
      return
    }
    setState(reduceRun(events, { source: 'replay' }))
  }, [stop])

  const clear = useCallback(() => {
    stop()
    setState(EMPTY_RUN)
  }, [stop])

  return { state, start, stop, replay, clear }
}

/** Fetch the list of saved runs from the bridge (empty when it is offline). */
export async function fetchSavedRuns(): Promise<string[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/runs`)
    if (!res.ok) return []
    const data = (await res.json()) as { runs?: string[] }
    return data.runs ?? []
  } catch {
    return []
  }
}

export async function fetchSavedRun(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/runs/${encodeURIComponent(name)}`)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Demo streams committed to public/runs, so replay works with the bridge offline. */
export const DEMO_RUNS = [
  { name: 'demo:VA-4dpu.jsonl', label: 'VA · 4 DPUs · vector add' },
  { name: 'demo:GEMV-4dpu.jsonl', label: 'GEMV · 4 DPUs · matrix–vector' },
  { name: 'demo:RED-4dpu.jsonl', label: 'RED · 4 DPUs · reduction + merge' },
]

/** Load either a bridge run or a bundled demo run. */
export async function loadRun(name: string): Promise<string | null> {
  if (name.startsWith('demo:')) {
    try {
      const res = await fetch(`/runs/${name.slice('demo:'.length)}`)
      return res.ok ? await res.text() : null
    } catch {
      return null
    }
  }
  return fetchSavedRun(name)
}
