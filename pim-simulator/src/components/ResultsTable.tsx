import type { Result } from '../engine/types'
import { fmtTime, fmtBytes, fmtEnergy, fmtSpeedup, fmtCount } from '../engine/format'
import { energyTotal } from '../engine/energy'

function Row({
  metric,
  cpu,
  pim,
  fmt,
  lowerIsBetter = true,
}: {
  metric: string
  cpu: string
  pim: string
  fmt?: number
  lowerIsBetter?: boolean
}) {
  void fmt
  const cpuNum = parseFloat(cpu)
  const pimNum = parseFloat(pim)
  const cpuWins = isNaN(cpuNum) || isNaN(pimNum) ? null : lowerIsBetter ? cpuNum < pimNum : cpuNum > pimNum
  return (
    <tr>
      <td>{metric}</td>
      <td className={cpuWins === true ? 'win' : cpuWins === false ? 'lose' : ''}>{cpu}</td>
      <td className={cpuWins === false ? 'win' : cpuWins === true ? 'lose' : ''}>{pim}</td>
    </tr>
  )
}

export function ResultsTable({ result, config }: { result: Result; config: { workload: string } }) {
  void config
  const ec = energyTotal(result.cpu.energy)
  const ep = energyTotal(result.pim.energy)
  const pimBytes = result.pim.bytesOffchip
  void pimBytes
  return (
    <div className="panel">
      <h3>Results</h3>
      <table className="results-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Conventional CPU</th>
            <th>PIM</th>
          </tr>
        </thead>
        <tbody>
          <Row metric="Execution time" cpu={fmtTime(result.cpu.time)} pim={fmtTime(result.pim.time)} />
          <Row metric="Speedup" cpu="—" pim={fmtSpeedup(result.speedup)} />
          <Row metric="Data movement" cpu={fmtBytes(result.cpu.bytes)} pim={fmtBytes(result.pim.bytesOffchip)} />
          <Row metric="Memory accesses" cpu={fmtCount(result.cpu.accesses)} pim={fmtCount(result.pim.accesses)} />
          <Row metric="Energy" cpu={fmtEnergy(ec)} pim={fmtEnergy(ep)} />
          <Row metric="Energy saving" cpu="—" pim={`${result.energySaving.toFixed(1)}%`} />
          <Row metric="Throughput" cpu={fmtCount(result.cpu.throughput)} pim={fmtCount(result.pim.throughput)} lowerIsBetter={false} />
        </tbody>
      </table>
      <div className="bound-chips">
        <span className={`chip ${result.cpu.bound}`}>CPU: {result.cpu.bound}-bound</span>
        <span className={`chip ${result.pim.bound}`}>PIM: {result.pim.bound.replace('pim', '')}-bound</span>
        {result.breakEvenRuns !== null && (
          <span className="chip info" title="Runs needed for time saved in-kernel to repay copy-in / copy-out">
            Break-even runs ≈ {result.breakEvenRuns.toFixed(1)}
          </span>
        )}
      </div>
      <p className="fineprint">
        n = {fmtCount(result.n)} elements · {result.units} PIM units · AI ={' '}
        {result.arithmeticIntensity.toFixed(2)} ops/B
      </p>
    </div>
  )
}
