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
npm run dev      # local development  → http://localhost:5173
npm run build    # production build (dist/)
npm run preview  # serve the production build
npm test         # engine + trace unit tests (Vitest)
```

The **Live DPU** page can also drive the real kernels in `../pim-kernels/`
through a zero-dependency bridge:

```bash
node bridge/server.mjs      # http://localhost:8787, SSE run stream
```

The bridge needs the UPMEM SDK environment (`../../upmem-env.sh`); it sources it
itself, so you do not need to export anything in the dashboard shell. Replay of
the bundled runs works with the bridge completely offline.

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
| **PIM internals** | The real DPU executed: MRAM/WRAM/DMA/tasklet diagram, formula inspector (symbolic → substituted → why), calibration ledger, measured runs vs model |
| **Live DPU** | Build and run the real UPMEM kernels from the browser, watch phases stream over SSE, replay saved runs, compare measured vs predicted |

## Real UPMEM execution

This is not only an analytical model. `../pim-kernels/` contains three C kernels
compiled by `dpu-upmem-dpurte-clang` to the **UPMEM DPU ISA**:

| Kernel | Shape | What it demonstrates |
|---|---|---|
| `VA` | `C = A + B` | Streams 256 B DMA blocks, no partials — bandwidth-shaped |
| `GEMV` | `y = A·x`, 1024×1024 per DPU | Matrix stays in MRAM, `x` broadcast into shared WRAM behind a barrier — multiply-bound |
| `RED` | `sum(D)` | Tasklet partials, hardware barrier, one partial per DPU merged by the host |

They run in the UPMEM **functional simulator** (no board attached): instruction-
accurate DPU cycle counts, with host wall time treated as simulation overhead.
See `../pim-kernels/README.md` for build details and portability notes.

The measured cycles and transfer times feed `src/engine/calibration.ts`. The
**PIM internals** page shows each constant with its source (measured here, PrIM
2022, SDK spec, DDR spec, or assumption) and can patch the live parameters with
measured values in one click.

## Live DPU bridge

`bridge/server.mjs` is a Node-only SSE server (no dependencies).

```text
GET /api/run?kernel=VA|GEMV|RED&dpus=4   source env, make, run host, stream JSON
GET /api/runs                            list saved .jsonl runs
GET /api/runs/:name                      fetch one saved run
GET /health                              liveness + kernel/env paths
```

Each kernel host prints one JSON event per line on stderr (`meta`, `phase`,
`dpu`, and for RED `merge`); the bridge forwards those frames, saves the run to
`pim-kernels/runs/`, and the page reduces file replay and a live stream through
the same reducer. Bundled demo streams in `public/runs/` make the page fully
usable with the bridge stopped.

## The model (first-order analytical)

**CPU** (memory and compute overlap — `max`, not `+`):

```text
T_CPU       = max(T_stream + T_random, T_compute)
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

- 15 engine unit tests reproduce the hand-worked Phase 1 example
  (Vector Add, n = 134 M int32: CPU 64.4 ms vs PIM 25.3 ms ⇒ 2.56× resident,
  0.72× when data must be copied in, break-even ≈ 1.6 runs).
- 8 trace tests check that every reported number equals the sum/max of the
  steps the inspector shows, that the critical path is marked once per side,
  that the resident/copy-in branch is respected, and that GEMV's multiply
  correction is > 1 on UPMEM while pure add stays at 1.
- Three real kernels compile for the DPU ISA and match a CPU reference at
  4 DPUs (0 errors each). The calibration ledger compares their measured
  cycles with the model at the same `P` and `n`.
- Suitability-score weights are fitted with logistic regression
  (label: speedup > 1) over 500 random configurations and reported with
  Spearman ρ and accuracy.
- Known limitations: first-order model — no row-buffer conflicts, refresh or
  memory-controller scheduling; some energy values are assumptions (editable).
  The functional DPU simulator is instruction-accurate but not cycle-accurate
  for memory contention, so absolute prediction error is expected to be largest
  on bandwidth-shaped kernels.

## Structure

```text
src/engine/    params · workloads · cpuModel · pimModel · energy
               simulate · sweep · suitability · optimizer · format
               trace (formula inspector) · calibration (measured ledger)
src/components ControlsPanel · ArchitectureViz · ResultsTable
               QuickComparison · PerformanceGraphs · Breakdowns
               Roofline · BankUtilization · SuitabilityCard · Charts
src/pages/     Simulator · Experiments · Results · Deep · Live · Learn · About
src/state/     store · hooks · live (SSE parser/reducer + demo replays)
bridge/        server.mjs — SSE bridge to the UPMEM kernels
public/runs/   bundled demo event streams (VA, GEMV, RED at 4 DPUs)
tests/         engine.test.ts · trace.test.ts
```

## Five-minute demo path

1. **Simulator** — Vector Add, default settings. CPU bus floods; PIM banks work
   in parallel. ~2.5× faster with ~90% less energy.
2. Untick **data already in PIM memory** → PIM loses; point at break-even runs.
3. **PIM internals** — walk the DPU diagram (MRAM / WRAM / DMA / tasklets),
   open a formula row, then apply the measured calibration ledger.
4. **Live DPU** — replay the bundled VA run (works offline), show the phase
   timeline and the measured-vs-model table; optionally start the bridge and
   run GEMV live to show the real DPU ISA executing.
5. **Experiments** — Reduction sweep: speedup flattens because partials merge
   through the host.


## References

1. Gómez-Luna et al., *Benchmarking a New Paradigm (PrIM)*, IEEE Access 2022 (arXiv:2105.03814)
2. Mutlu et al., *A Modern Primer on Processing in Memory* (arXiv:2012.03112)
3. Lee et al., *Hardware Architecture and Software Stack for PIM…* (HBM-PIM), ISCA 2021
4. Williams, Waterman, Patterson, *Roofline*, CACM 2009
5. Horowitz, *Computing's Energy Problem*, ISSCC 2014
