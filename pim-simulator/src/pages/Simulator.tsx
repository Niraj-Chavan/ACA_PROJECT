import { useStore, useDebounced } from '../state/hooks'
import { ControlsPanel, formatDataSize } from '../components/ControlsPanel'
import { ResultsTable } from '../components/ResultsTable'
import { QuickComparison } from '../components/QuickComparison'
import { PerformanceGraphs } from '../components/PerformanceGraphs'
import { TimeBreakdown, EnergyBreakdown } from '../components/Breakdowns'
import { Roofline } from '../components/Roofline'
import { BankUtilization, computeUtilFromTimeline } from '../components/BankUtilization'
import { ArchitectureViz } from '../components/ArchitectureViz'
import { SuitabilityCard } from '../components/SuitabilityCard'
import { workloadById } from '../engine/workloads'
import { useState } from 'react'
import type { PerfTab } from '../state/store'

export function Simulator() {
  const { state, dispatch } = useStore()
  const [perfTab, setPerfTab] = useState<PerfTab>('time')
  const debounced = useDebounced(state, 50) // keeps slider dragging smooth

  const wl = workloadById(state.workloadId)
  void debounced
  const util = computeUtilFromTimeline(state.result, Math.min(state.params.pim.banks, 4096))

  return (
    <div className="page">
      <div className={`resident-badge ${state.params.dataResident ? 'resident' : 'cold'}`}>
        <div>
          <strong>
            {state.params.dataResident
              ? 'PIM copy-in is 0 B by assumption: the data is already resident in PIM banks.'
              : 'Cold data: every PIM run pays copy-in on the host ↔ PIM link.'}
          </strong>
          <span>
            {state.params.dataResident
              ? ' This is the mockup preset’s resident-data assumption, not a missing transfer. Toggle it to see the cold-data case and the break-even point.'
              : ' This is the honest streaming case. Toggle back to the resident-data assumption used by the Phase 1 worked example.'}
          </span>
        </div>
        <button
          className="btn small"
          onClick={() => dispatch({ type: 'patchDataResident', value: !state.params.dataResident })}
        >
          {state.params.dataResident ? 'Charge copy-in (cold data)' : 'Assume resident data'}
        </button>
      </div>
      <div className="sim-grid">
        <ControlsPanel dataBytes={state.dataBytes} />

        <div className="sim-mid">
          <ArchitectureViz result={state.result} />
          <QuickComparison result={state.result} />
          <PerformanceGraphs state={state} tab={perfTab} setTab={setPerfTab} />
          <TimeBreakdown result={state.result} />
          <EnergyBreakdown result={state.result} />
        </div>

        <div className="sim-right">
          <ResultsTable result={state.result} config={{ workload: wl.short }} />
          <BankUtilization util={util} banks={Math.min(state.params.pim.banks, 4096)} />
          <Roofline result={state.result} params={state.params} workloadId={state.workloadId} />
          <SuitabilityCard
            suitability={state.suitability}
            validation={state.validation}
            params={state.params}
            workloadId={state.workloadId}
            n={state.result.n}
            dispatch={dispatch}
          />
        </div>
      </div>
      <p className="fineprint">
        Data set: {formatDataSize(state.dataBytes)} · toggle “Data already in PIM memory” to see the copy-in
        cost, “Result needed on host” to add copy-out.
      </p>
    </div>
  )
}
