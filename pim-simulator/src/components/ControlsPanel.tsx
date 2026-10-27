import { useDispatch, useSelector } from '../state/hooks'
import type { Params } from '../engine/types'
import { allWorkloads } from '../engine/workloads'
import { PRESET_LABELS } from '../engine/params'
import type { Action } from '../state/store'

interface SliderDef {
  key: string
  label: string
  unit: string
  min: number
  max: number
  step: number
  log?: boolean
  tip: string
}

const CPU_SLIDERS: SliderDef[] = [
  { key: 'freqGHz', label: 'CPU frequency', unit: 'GHz', min: 0.5, max: 6, step: 0.1, tip: 'Clock rate of each CPU core' },
  { key: 'cores', label: 'CPU cores', unit: '', min: 1, max: 128, step: 1, tip: 'Number of active CPU cores' },
  { key: 'opsPerCycle', label: 'Ops per cycle', unit: '', min: 1, max: 128, step: 1, tip: 'Arithmetic ops issued per core per cycle' },
  { key: 'memBWGBs', label: 'Memory bandwidth', unit: 'GB/s', min: 8, max: 1200, step: 0.1, tip: 'Off-chip bus bandwidth (streaming)' },
  { key: 'memLatencyNs', label: 'Memory latency', unit: 'ns', min: 40, max: 300, step: 1, tip: 'Round-trip latency for one random access' },
  { key: 'mlp', label: 'Outstanding misses', unit: '/core', min: 1, max: 64, step: 1, tip: 'Memory-level parallelism: misses in flight per core' },
]

const PIM_SLIDERS: SliderDef[] = [
  { key: 'banks', label: 'Memory banks', unit: '', min: 1, max: 4096, step: 1, log: true, tip: 'PIM-capable banks (UPMEM has 2,560 DPUs)' },
  { key: 'unitsPerBank', label: 'PIM units per bank', unit: '', min: 1, max: 4, step: 1, tip: 'Processing units attached to each bank' },
  { key: 'freqGHz', label: 'PIM frequency', unit: 'GHz', min: 0.2, max: 2, step: 0.05, tip: 'Clock of each PIM core' },
  { key: 'opsPerCycle', label: 'PIM ops per cycle', unit: '', min: 0.1, max: 16, step: 0.1, tip: 'Arithmetic ops per PIM core per cycle' },
  { key: 'bankBWGBs', label: 'Bank bandwidth', unit: 'GB/s', min: 0.2, max: 30, step: 0.1, tip: 'Internal bank bandwidth per PIM unit' },
  { key: 'copyBWGBs', label: 'Host↔PIM copy BW', unit: 'GB/s', min: 1, max: 1200, step: 1, tip: 'Bandwidth of the bus used for copy-in / copy-out' },
  { key: 'mulCost', label: 'Multiply cost', unit: '× add', min: 1, max: 6, step: 0.1, tip: 'Multiply latency relative to an add (UPMEM does it in software)' },
  { key: 'launchUs', label: 'Launch overhead', unit: 'µs', min: 0, max: 200, step: 1, tip: 'Kernel launch cost paid every run' },
  { key: 'syncUs', label: 'Sync latency', unit: 'µs', min: 0, max: 100, step: 1, tip: 'Cost per synchronisation with the host' },
]

const ENERGY_SLIDERS: SliderDef[] = [
  { key: 'offchipPJperB', label: 'Off-chip energy', unit: 'pJ/B', min: 8, max: 400, step: 1, tip: 'Energy per byte moved over the bus (Horowitz ISSCC 2014 range)' },
  { key: 'inbankPJperB', label: 'In-bank energy', unit: 'pJ/B', min: 2, max: 60, step: 1, tip: 'Energy per byte accessed inside a bank (assumption)' },
  { key: 'cpuPJperOp', label: 'CPU energy/op', unit: 'pJ', min: 2, max: 80, step: 1, tip: 'Energy per arithmetic op on the CPU' },
  { key: 'pimPJperOp', label: 'PIM energy/op', unit: 'pJ', min: 1, max: 40, step: 0.5, tip: 'Energy per arithmetic op on a PIM unit' },
  { key: 'pimUnitW', label: 'Power per PIM unit', unit: 'W', min: 0.01, max: 0.5, step: 0.01, tip: 'Static+dynamic power of one PIM unit' },
]

function logSliderValue(v: number): number {
  return Math.pow(10, (Math.log10(v >= 1024 ? v : 1024) - 3)) // unused helper placeholder
}

function Slider({
  def,
  value,
  onChange,
}: {
  def: SliderDef
  value: number
  onChange: (v: number) => void
}) {
  const log = !!def.log
  const setFromSlider = (sv: number) => {
    const raw = log ? Math.pow(10, sv) : sv
    onChange(log ? Math.round(raw) : sv)
  }
  const sv = log ? Math.log10(Math.max(value, def.min)) : value
  return (
    <div className="slider-row" title={def.tip}>
      <label>
        {def.label} <span className="unit-info" aria-hidden>ⓘ</span>
      </label>
      <div className="slider-line">
        <input
          type="range"
          min={log ? Math.log10(def.min) : def.min}
          max={log ? Math.log10(def.max) : def.max}
          step={log ? 0.01 : def.step}
          value={sv}
          onChange={(e) => setFromSlider(parseFloat(e.target.value))}
        />
        <span className="slider-val">
          {value >= 1024 && log ? Math.round(value) : value.toFixed(log ? 0 : def.step < 1 ? 2 : 0)}
          {` ${def.unit}`}
        </span>
      </div>
    </div>
  )
}

export function ControlsPanel({ dataBytes }: { dataBytes: number }) {
  const dispatch = useDispatch()
  const params = useSelector((s) => s.params)
  const workloadId = useSelector((s) => s.workloadId)
  const patch = (section: 'cpu' | 'pim' | 'energy') => (key: string) => (value: number) =>
    dispatch({ type: 'patch', section, key, value })

  const setDataBytes = (bytes: number) => dispatch({ type: 'setDataBytes', bytes })

  return (
    <div className="controls panel">
      <div className="control-group">
        <h3>1 · Workload</h3>
        <select value={workloadId} onChange={(e) => dispatch({ type: 'setWorkload', id: e.target.value })}>
          {allWorkloads.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <p className="workload-desc">{allWorkloads.find((w) => w.id === workloadId)?.description}</p>
      </div>

      <div className="control-group">
        <h3>2 · Data size</h3>
        <div className="slider-row" title="Total data touched (log scale, 1 KB → 10 GB)">
          <label>Elements (int32) ⓘ</label>
          <div className="slider-line">
            <input
              type="range"
              min={3}
              max={34.35}
              step={0.05}
              value={Math.log2(dataBytes)}
              onChange={(e) => setDataBytes(Math.pow(2, parseFloat(e.target.value)))}
            />
            <span className="slider-val">
              {formatDataSize(dataBytes)}
            </span>
          </div>
        </div>
      </div>

      <div className="control-group">
        <h3>3 · Architecture</h3>
        <select
          value={params.preset}
          onChange={(e) => dispatch({ type: 'setPreset', preset: e.target.value as Params['preset'] })}
        >
          {Object.entries(PRESET_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              Preset: {v}
            </option>
          ))}
        </select>
        <details open>
          <summary>CPU</summary>
          {CPU_SLIDERS.map((d) => (
            <Slider key={`cpu-${d.key}`} def={d} value={(params.cpu as unknown as Record<string, number>)[d.key]} onChange={patch('cpu')(d.key)} />
          ))}
        </details>
        <details open>
          <summary>PIM</summary>
          {PIM_SLIDERS.map((d) => (
            <Slider key={`pim-${d.key}`} def={d} value={(params.pim as unknown as Record<string, number>)[d.key]} onChange={patch('pim')(d.key)} />
          ))}
        </details>
        <details>
          <summary>Energy</summary>
          {ENERGY_SLIDERS.map((d) => (
            <Slider key={`en-${d.key}`} def={d} value={(params.energy as unknown as Record<string, number>)[d.key]} onChange={patch('energy')(d.key)} />
          ))}
        </details>
        <label className="toggle">
          <input
            type="checkbox"
            checked={params.dataResident}
            onChange={(e) => dispatch({ type: 'patchDataResident', value: e.target.checked })}
          />
          Data already in PIM memory
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={params.resultNeededOnHost}
            onChange={(e) => dispatch({ type: 'patchResultOnHost', value: e.target.checked })}
          />
          Result needed on host
        </label>
        <div className="btn-row">
          <button className="btn primary" onClick={() => dispatch({ type: 'saveRun', name: snapshotName(workloadId, params) })}>
            Save run
          </button>
          <button className="btn" onClick={() => dispatch({ type: 'reset' })}>
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

function snapshotName(workloadId: string, params: Params): string {
  return `${workloadId} @ ${params.pim.banks} banks`
}

export function formatDataSize(bytes: number): string {
  const e = bytes
  if (e >= 1024 ** 3) return `${(e / 1024 ** 3).toFixed(2)} GB`
  if (e >= 1024 ** 2) return `${(e / 1024 ** 2).toFixed(1)} MB`
  if (e >= 1024) return `${(e / 1024).toFixed(0)} KB`
  return `${e.toFixed(0)} B`
}

void logSliderValue
