import { useStore } from '../state/hooks'
import { workloadById } from '../engine/workloads'
import { fmtTime, fmtBytes } from '../engine/format'
import { formatDataSize } from '../components/ControlsPanel'

export function Results() {
  const { state, dispatch } = useStore()
  if (state.runs.length === 0) {
    return (
      <div className="page">
        <h2>Results</h2>
        <p className="fineprint">
          No saved runs yet. Go to the Simulator, configure a run and press “Save run” to keep it here for side-by-side comparison.
        </p>
      </div>
    )
  }
  return (
    <div className="page">
      <h2>Results</h2>
      <table className="results-table wide">
        <thead>
          <tr>
            <th>Run</th>
            <th>Workload</th>
            <th>Data</th>
            <th>Preset</th>
            <th>Banks × units</th>
            <th>Resident?</th>
            <th>CPU time</th>
            <th>PIM time</th>
            <th>Speedup</th>
            <th>Energy saving</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.runs.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{workloadById(r.workloadId).short}</td>
              <td>{formatDataSize(r.dataBytes)}</td>
              <td>{r.params.preset}</td>
              <td>{r.params.pim.banks} × {r.params.pim.unitsPerBank}</td>
              <td>{r.params.dataResident ? 'yes' : 'no'}</td>
              <td>{fmtTime(r.cpuTimeS)}</td>
              <td>{fmtTime(r.pimTimeS)}</td>
              <td>{r.speedup.toFixed(2)}×</td>
              <td>{r.energySavingPct.toFixed(0)}%</td>
              <td>
                <button className="btn small" onClick={() => dispatch({ type: 'deleteRun', id: r.id })}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fineprint">Data movement at the last saved configuration: {fmtBytes(state.result.cpu.bytes)} on the bus before PIM.</p>
    </div>
  )
}
