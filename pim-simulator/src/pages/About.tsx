export function About() {
  return (
    <div className="page narrow">
      <h2>About</h2>
      <section>
        <h3>What this is</h3>
        <p>
          An interactive, analytical simulator comparing a conventional CPU with a Processing-in-Memory (PIM)
          system. Built for the Advanced Computer Architecture course project "Processing-in-Memory (PIM)
          Architecture Simulator and Performance Analysis".
        </p>
        <p>
          Contribution: (1) a configurable CPU-vs-PIM simulator that models the costs usually omitted — copy-in,
          host-side merging, copy-out, launch and sync overhead, load imbalance; (2) a PIM Suitability Score
          whose weights are fitted and validated against simulated speedups over hundreds of configurations;
          (3) a configuration optimiser that searches banks × units × frequency under a power budget.
        </p>
      </section>

      <section>
        <h3>Model limitations</h3>
        <ul className="limitations">
          <li>First-order analytical model — trends, not cycle timings.</li>
          <li>No row-buffer conflicts, DRAM refresh or memory-controller scheduling.</li>
          <li>The CPU cache hierarchy is coarsely modelled through the roofline arithmetic intensity; per-line effects are not simulated.</li>
          <li>In-bank access energy and PIM op energy are assumptions (editable in the UI); off-chip energy follows published DDR ranges (Horowitz, ISSCC 2014).</li>
          <li>Bank internal bandwidth and the ~60 ns in-bank random access are assumptions.</li>
          <li>Preset values approximate published UPMEM (PrIM, IEEE Access 2022) and Samsung HBM-PIM (ISCA 2021) numbers.</li>
        </ul>
      </section>

      <section>
        <h3>References</h3>
        <ol className="refs">
          <li>J. Gómez-Luna et al., "Benchmarking a New Paradigm: Experimental Analysis and Characterization of a Real Processing-in-Memory System," IEEE Access, 2022 (arXiv:2105.03814).</li>
          <li>O. Mutlu et al., "A Modern Primer on Processing in Memory," arXiv:2012.03112.</li>
          <li>B. Hyun et al., "Pathfinding Future PIM Architectures…(uPIMulator)," HPCA 2024, arXiv:2308.00846.</li>
          <li>CMU SAFARI, Ramulator-PIM, github.com/CMU-SAFARI/ramulator-pim.</li>
          <li>"Modeling and Simulation Frameworks for Processing-in-Memory Architectures," arXiv:2512.00096, 2025.</li>
          <li>S. Lee et al., "Hardware Architecture and Software Stack for PIM Based on Commercial DRAM Technology," ISCA 2021.</li>
          <li>S. Williams, A. Waterman, D. Patterson, "Roofline," CACM 2009.</li>
          <li>M. Horowitz, "Computing's Energy Problem," ISSCC 2014.</li>
          <li>J. Hennessy, D. Patterson, Computer Architecture: A Quantitative Approach, 6th ed.</li>
        </ol>
      </section>
    </div>
  )
}
