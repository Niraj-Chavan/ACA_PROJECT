# PIM Architecture Simulator — CPU vs Processing-in-Memory

An interactive, PhET-style simulator that compares a conventional CPU with a
Processing-in-Memory (PIM) system for a configurable workload, data size and
architecture. Built with **React + TypeScript** (engine runs in the browser —
no server needed).

> Central question: *for a given workload and memory configuration, when does
> PIM beat a conventional CPU, by how much, and what limits it?*

## Run it

```bash
npm install
npm run dev      # local development
npm run build    # production build (dist/)
npm run preview  # serve the production build
npm test         # engine unit tests (Vitest)
```

## What it shows

| Panel | What it answers |
|---|---|
| **Datapath animation** | How data moves: CPU floods the shared bus; PIM works inside the banks |
| **Results table** | Execution time, speedup, data movement, accesses, energy, throughput — winner highlighted |
| **Performance graphs** | Time / speedup / data / energy / throughput vs data size (log–log) |
| **Roofline** | CPU and PIM roofs, the workload's arithmetic-intensity operating point |
| **Bank utilisation** | CPU mode: banks idle (bus-bound); PIM mode: every unit busy (with imbalance) |
| **Time / energy breakdown** | Copy-in · kernel · merge · copy-out vs CPU stream/compute |
| **PIM Suitability** | 0–100 score from four model-derived factors, validated with a fitted-threshold accuracy report |
| **Optimiser** | Best banks × units × frequency under a power budget, with a Pareto front |
| **Experiments** | E1–E10 sweeps with charts, CSV download and written observations |

## The model (first-order analytical)

**CPU** (memory and compute overlap — `max`, not `+`):

```text
T McCartCPU = max(T_stream + T_random, T_compute)
T_stream    = bytes / BW_mem
T_random    = random_accesses × latency / (cores × MLP)
T_compute   = ops / (cores × f × ops_per_cycle)
```

**PIM** (models the costs usually left out):

```text
T_PIM = T_copy-in + T_launch + T_kernel + T_merge + T_copy-out + syncs × T_sync
T_kernel = max(T_bank, T_PIM_compute)      # per unit, with load imbalance
T_merge  = P × partial_bytes / copy_BW + merge_ops / host_rate
```

Metrics: speedup, energy saving ((E_CPU − E_PIM)/E_CPU), break-even runs
((T_in + T_out)/(T_CPU − T_kernel)), bank utilisation.

**Workloads**: Vector Add, Vector Mul, Reduction, Select/Search, GEMV
(headline PIM case), GEMM (the CPU counterexample — high reuse), and stretch:
Histogram, BFS.

**Presets** (Appendix B of the plan): Simple mockup, UPMEM-like (2,560 DPUs,
0.35 GHz), HBM-PIM-like (Samsung Aquabolt-XL style). Energy values follow
Horowitz ISSCC 2014 ranges and the PrIM benchmark measurements.

## Validation

- 15 Vitest unit tests reproduce the hand-worked Phase 1 example
  (Vector Add, n = 134 M int32: CPU 64.4 ms vs PIM 25.3 ms ⇒ 2.56× resident,
  0.72× when data must be copied in, break-even ≈ 1.6 runs).
- Suitability-score weights are fitted with logistic regression
  (label: speedup > 1) over 500 random configurations and reported with
  Spearman ρ and accuracy.
- Known limitations: first-order model — no row-buffer conflicts, refresh or
  memory-controller scheduling; some energy values are assumptions (editable).

## Structure

```text
src/engine/    params · workloads · cpuModel · pimModel · energy
               simulate · sweep · suitability · optimizer · format
src/components ControlsPanel · ArchitectureViz · ResultsTable
               QuickComparison · PerformanceGraphs · Breakdowns
               Roofline · BankUtilization · SuitabilityCard · Charts
src/pages/     Simulator · Experiments · Results · Learn · About
tests/         engine.test.ts
```

## References

1. Gómez-Luna et al., *Benchmarking a New Paradigm (PrIM)*, IEEE Access 2022 (arXiv:2105.03814)
2. Mutlu et al., *A Modern Primer on Processing in Memory* (arXiv:2012.03112)
3. Lee et al., *Hardware Architecture and Software Stack for PIM…* (HBM-PIM), ISCA 2021
4. Williams, Waterman, Patterson, *Roofline*, CACM 2009
5. Horowitz, *Computing's Energy Problem*, ISSCC 2014
