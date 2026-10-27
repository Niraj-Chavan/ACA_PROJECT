import type { Params, Result, Phase } from '../engine/types'
import { defaultParams, presets } from '../engine/params'
import { workloadById, allWorkloads } from '../engine/workloads'
import { simulate } from '../engine/simulate'
import {
  computeSuitability,
  validateScore,
  DEFAULT_WEIGHTS,
  type Suitability,
  type ValidationReport,
} from '../engine/suitability'

export type { Suitability }

export interface SavedRun {
  id: string
  name: string
  params: Params
  workloadId: string
  dataBytes: number
  cpuTimeS: number
  pimTimeS: number
  speedup: number
  energySavingPct: number
}

export type PerfTab = 'time' | 'speedup' | 'data' | 'energy' | 'throughput'

export interface AppState {
  params: Params
  workloadId: string
  dataBytes: number
  result: Result
  suitability: Suitability
  validation: ValidationReport | null
  runs: SavedRun[]
  perfTab: PerfTab
}

export type Action =
  | { type: 'setPreset'; preset: Params['preset'] }
  | { type: 'setWorkload'; id: string }
  | { type: 'setDataBytes'; bytes: number }
  | { type: 'patch'; section: 'cpu' | 'pim' | 'energy'; key: string; value: number }
  | { type: 'patchDataResident'; value: boolean }
  | { type: 'patchResultOnHost'; value: boolean }
  | { type: 'reset' }
  | { type: 'saveRun'; name: string }
  | { type: 'deleteRun'; id: string }
  | { type: 'setValidation'; report: ValidationReport }

const N_FROM_BYTES = (bytes: number) => Math.max(64, Math.round(bytes / 4))

export function derive(s: Omit<AppState, 'result' | 'suitability'> & Partial<AppState>): AppState {
  const n = N_FROM_BYTES(s.dataBytes)
  const workload = workloadById(s.workloadId)
  const result = simulate(s.params, workload, n)
  const weights = s.validation?.weights ?? DEFAULT_WEIGHTS
  const suitability = computeSuitability(s.params, workload, n, weights)
  return { ...s, result, suitability } as AppState
}

export function initialState(): AppState {
  return derive({
    params: JSON.parse(JSON.stringify(defaultParams)) as Params,
    workloadId: 'VA',
    dataBytes: 4 * 134_217_728, // 512 MiB per array, as in the Phase 1 worked example
    validation: null,
    runs: [],
    perfTab: 'time',
  })
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'setPreset':
      return derive({ ...state, params: JSON.parse(JSON.stringify(presets[action.preset])) })
    case 'setWorkload':
      return derive({ ...state, workloadId: action.id })
    case 'setDataBytes':
      return derive({ ...state, dataBytes: action.bytes })
    case 'patch': {
      const params = JSON.parse(JSON.stringify(state.params)) as Params
      ;(params[action.section] as unknown as Record<string, number>)[action.key] = action.value
      return derive({ ...state, params })
    }
    case 'patchDataResident':
      return derive({ ...state, params: { ...state.params, dataResident: action.value } })
    case 'patchResultOnHost':
      return derive({ ...state, params: { ...state.params, resultNeededOnHost: action.value } })
    case 'reset':
      return { ...initialState(), runs: state.runs }
    case 'saveRun': {
      const run: SavedRun = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: action.name,
        params: JSON.parse(JSON.stringify(state.params)),
        workloadId: state.workloadId,
        dataBytes: state.dataBytes,
        cpuTimeS: state.result.cpu.time,
        pimTimeS: state.result.pim.time,
        speedup: state.result.speedup,
        energySavingPct: state.result.energySaving,
      }
      return { ...state, runs: [...state.runs, run] }
    }
    case 'deleteRun':
      return { ...state, runs: state.runs.filter((r) => r.id !== action.id) }
    case 'setValidation':
      return derive({ ...state, validation: action.report })
    default:
      return state
  }
}

/** runs the 500-config validation for the score; heavy, call on demand */
export function runValidation(): ValidationReport {
  return validateScore(Object.values(presets), allWorkloads, 500, 42)
}

// re-exports used by components
export { workloadById, allWorkloads, presets, defaultParams }
export type { Phase }
