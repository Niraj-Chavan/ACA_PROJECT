export function Learn() {
  return (
    <div className="page narrow">
      <h2>Learn</h2>

      <section>
        <h3>The memory wall</h3>
        <p>
          CPU compute throughput has grown far faster than DRAM bandwidth. A modern 8-core CPU can execute
          tens of billions of arithmetic operations per second, but a 25 GB/s bus can deliver only ~6 billion
          int32 values per second. Once the working set exceeds the caches, the CPU spends much of its time
          <em> waiting for data</em> — that is the memory wall.
        </p>
      </section>

      <section>
        <h3>Where data lives: registers → caches → DRAM</h3>
        <p>
          Registers are read in ~0.3 ns, L1 in ~1 ns, L3 in ~15 ns, DRAM in ~100 ns but through a shared
          bus with limited bandwidth. Programs that <em>reuse</em> data (matrix multiply) stay in the caches
          and run at full compute speed; programs that <em>stream</em> data once (vector add) are pinned to
          bus bandwidth.
        </p>
      </section>

      <section>
        <h3>Latency vs bandwidth</h3>
        <p>
          Latency = the time of one request (~100 ns to DRAM). Bandwidth = bytes per second.
          <em> Memory-level parallelism (MLP)</em> lets one core keep several misses in flight, but every
          byte still crosses the same off-chip bus.
        </p>
      </section>

      <section>
        <h3>DRAM organisation</h3>
        <p>
          Channel → rank → chip → bank → row. Each bank has a row buffer; a bank can only serve one row at
          a time, which is why banks are the natural place to attach compute. Real systems have hundreds to
          thousands of banks; UPMEM machines expose 2,560 processing units, one per bank.
        </p>
      </section>

      <section>
        <h3>Roofline in 60 seconds</h3>
        <p>
          Plot performance (ops/s) against arithmetic intensity (ops per byte moved). The "roof" is min(
          peak compute, AI × bandwidth). Left of the <em>ridge point</em> the workload is memory-bound;
          right of it, compute-bound. Vector add sits near AI = 0.17 ops/B — deep on the memory roof —
          whereas tiled matrix multiply runs at AI &gt; the ridge, so only compute speed matters.
        </p>
      </section>

      <section>
        <h3>Processing-in-Memory: two kinds</h3>
        <ul>
          <li><strong>Processing-near-memory (PNM)</strong>: add simple logic beside the banks (UPMEM DPUs, Samsung HBM-PIM, SK hynix GDDR6-AiM). Each unit works on its own bank's data — no cross-bus traffic.</li>
          <li><strong>Processing-using-memory (PUM)</strong>: make the DRAM cells themselves compute — e.g. RowClone copies a row inside a bank for many cycles less energy, Ambit performs bitwise ops with the sense amplifiers.</li>
        </ul>
      </section>

      <section>
        <h3>The catch PIM marketing omits</h3>
        <p>
          Data must get <em>into</em> PIM memory. If it is not already there, the copy crosses the very bus
          PIM was supposed to avoid. Partial results (reductions, histograms) must merge through the host,
          and launch/sync overheads are paid every run. This simulator models all of those costs.
        </p>
      </section>

      <section>
        <h3>Glossary</h3>
        <dl className="glossary">
          <dt>Arithmetic intensity (AI)</dt><dd>operations per byte moved off-chip</dd>
          <dt>Ridge point</dt><dd>peak compute ÷ bandwidth, ops/byte</dd>
          <dt>DPU</dt><dd>UPMEM's DRAM Processing Unit — one per bank</dd>
          <dt>GEMV / GEMM</dt><dd>matrix–vector / dense matrix–matrix multiply</dd>
          <dt>Break-even runs</dt><dd>(T_in + T_out) ÷ (T_CPU − T_kernel): the number of repeated runs after which the copy pays back</dd>
          <dt>MLP</dt><dd>outstanding cache misses per core</dd>
        </dl>
      </section>
    </div>
  )
}
