import type { Result } from '../engine/types'
import { fmtTime, fmtBytes, fmtEnergy } from '../engine/format'
import { energyTotal } from '../engine/energy'
import { HBars } from './Charts'

export function QuickComparison({ result }: { result: Result }) {
  const ec = energyTotal(result.cpu.energy)
  const ep = energyTotal(result.pim.energy)
  return (
    <div className="panel">
      <h3>Quick compare</h3>
      <div className="qc-grid">
        <div>
          <h4>Time</h4>
          <HBars
            rows={[
              { label: 'CPU', value: result.cpu.time, color: 'var(--cpu)' },
              { label: 'PIM', value: result.pim.time, color: 'var(--pim)' },
            ]}
            fmt={fmtTime}
          />
        </div>
        <div>
          <h4>Data over bus</h4>
          <HBars
            rows={[
              { label: 'CPU', value: result.cpu.bytes, color: 'var(--cpu)' },
              { label: 'PIM', value: result.pim.bytesOffchip, color: 'var(--pim)' },
            ]}
            fmt={fmtBytes}
          />
        </div>
        <div>
          <h4>Energy</h4>
          <HBars
            rows={[
              { label: 'CPU', value: ec, color: 'var(--cpu)' },
              { label: 'PIM', value: ep, color: 'var(--pim)' },
            ]}
            fmt={fmtEnergy}
          />
        </div>
      </div>
    </div>
  )
}
