import { useState } from 'react'
import type { Params } from '../engine/types'
import type { Suitability } from '../state/store'
import type { ValidationReport } from '../engine/suitability'
import type { Action } from '../state/store'
import { runValidation } from '../state/store'
import { optimize, type Objective } from '../engine/optimizer'
import { workloadById } from '../engine/workloads'
import { Gauge, FactorBars } from './Charts'
import { fmtSpeedup } from '../engine/format'

export function SuitabilityCard({
  suitability,
  validation,
  params,
  workloadId,
  n,
  dispatch,
}: {
  suitability: Suitability
  validation: ValidationReport | null
  params: Params
  workloadId: string
  n: number
  dispatch: (a: Action) => void
}) {
  const [busy, setBusy] = useState(false)
  const [objective, setObjective] = useState<Objective>('time')
  const [budget, setBudget] = useState(50)

  const validate = () => {
    setBusy(true)
    setTimeout(() => {
      try {
        const rep = runValidation()
        dispatch({ type: 'setValidation', report: rep })
      } finally {
        setBusy(false)
      }
    }, 30)
  }

  const wl = workloadById(workloadId)
  const opt = optimize(params, wl, n, objective, budget)

  return (
    <div className="panel suitability-card">
      <h3>PIM Suitability</h3>
      <div className="suit-row">
        <Gauge score={suitability.score} label={suitability.label} />
        <FactorBars
          factors={[
            { name: 'Memory intensity', value: suitability.factors.memoryIntensity },
            { name: 'Parallelism', value: suitability.factors.parallelism },
            { name: 'Bus traffic saved', value: suitability.factors.dataMovementSaved },
            { name: 'Compute fit', value: suitability.factors.computeFit },
          ]}
        />
      </div>

      <p className="recommendation">{suitability.recommendation}</p>

      <div className="validation">
        {validation ? (
          <p>
            ✓ Validated on {validation.rows} random configurations —{' '}
            <strong>Spearman ρ = {validation.spearman.toFixed(2)}</strong> vs log(speedup), accuracy{' '}
            <strong>{(validation.accuracy * 100).toFixed(0)}%</strong> at score ≥ {validation.threshold}. Fitted
            weights: w₁={validation.weights.w1.toFixed(2)}, w₂={validation.weights.w2.toFixed(2)},{' '}
            w₃={validation.weights.w3.toFixed(2)}, w₄={validation.weights.w4.toFixed(2)}.
          </p>
        ) : (
          <p className="fineprint">Weights are fitted against the model; run the validation to report accuracy.</p>
        )}
        <button className="btn" onClick={validate} disabled={busy}>
          {busy ? 'Simulating 500 configs…' : 'Validate score (500 configs)'}
        </button>
      </div>

      <details className="optimizer">
        <summary>Optimiser — best configuration under a power budget</summary>
        <div className="opt-controls">
          <label>
            Objective
            <select value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
              <option value="time">Minimum time</option>
              <option value="energy">Minimum energy</option>
              <option value="ed">Minimum energy × delay</option>
            </select>
          </label>
          <label>
            Power budget (W)
            <input
              type="number"
              min={1}
              max={500}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value) || 1)}
            />
          </label>
        </div>
        {opt.recommended && (
          <p>
            <strong>
              {opt.recommended.banks} banks × {opt.recommended.unitsPerBank} units @ {opt.recommended.freqGHz} GHz
            </strong>{' '}
            ({opt.recommended.powerW.toFixed(2)} W) → {fmtSpeedup(opt.recommended.speedup)},{' '}
            {opt.recommended.energySavingPct.toFixed(0)}% energy saving. {opt.inBudget} configurations in budget;{' '}
            {opt.pareto.length} on the Pareto front.
          </p>
        )}
        <p className="fineprint">{opt.message}</p>
      </details>
    </div>
  )
}
