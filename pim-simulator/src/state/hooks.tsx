import React, { createContext, useContext, useEffect, useRef, useMemo } from 'react'
import { useReducer } from 'react'
import type { ReactNode } from 'react'
import type { AppState } from './store'
import { initialState, reducer, type Action } from './store'

const StoreCtx = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  // keep last 50ms of slider drags smooth: recompute is fast (~µs), but the
  // reducer is synchronous anyway — no debounce needed for µs-scale engine.
  return <StoreCtx.Provider value={{ state, dispatch }}>{children}</StoreCtx.Provider>
}

export function useStore() {
  const ctx = useContext(StoreCtx)
  if (!ctx) throw new Error('useStore outside provider')
  return ctx
}

export function useSelector<T>(sel: (s: AppState) => T): T {
  return sel(useStore().state)
}

export function useDispatch() {
  return useStore().dispatch
}

/** debounced value hook, used for slider-driven recomputes (~50 ms) */
export function useDebounced<T>(value: T, ms = 50): T {
  const [v, setV] = React.useState(value)
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (t.current) clearTimeout(t.current)
    t.current = setTimeout(() => setV(value), ms)
    return () => {
      if (t.current) clearTimeout(t.current)
    }
  }, [value, ms])
  return v
}

export function useMemoState<T>(fn: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(fn, deps)
}
