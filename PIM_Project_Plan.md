# Processing-in-Memory (PIM) Architecture Simulator and Performance Analysis

**Subtitle:** An Interactive Simulation Framework for Evaluating Data Movement, Performance and Energy in PIM Architectures
**Course:** Advanced Computer Architecture
**Plan length:** 6 weeks, 10 phases (Phase 0 to Phase 9)
**Plan date:** 27 October 2026

## 0. Project summary

### What we are building

A PhET-style interactive simulator that runs in the browser. The user changes architecture parameters (memory bandwidth, latency, banks, PIM units, frequencies, workload, data size). The simulator immediately shows:

1. An animated comparison of a conventional CPU and a PIM system moving and processing data.
2. Execution time, speedup, data movement, memory accesses, energy, energy saving and throughput.
3. Graphs, a roofline chart, bank utilisation and an energy breakdown.
4. A PIM Suitability Score and a recommended hardware configuration.

```text
CONTROLS  →  SIMULATION ENGINE  →  VISUALISATION  →  MEASUREMENTS / GRAPHS
(sliders)    (CPU + PIM + memory     (animated         (results table,
              + energy models)        datapath)          charts, score)
```

### Central research question

> For a given workload and memory configuration, when does Processing-in-Memory beat a conventional CPU, by how much, and what limits it?

Sub-questions:

1. Which workloads benefit from PIM, and which do not?
2. How does speedup change with data size, number of PIM units, memory bandwidth and memory latency?
3. How much data movement and energy does PIM save?
4. What is the cost of copying data into PIM memory, and after how many runs does it pay back?
5. Can a simple score predict whether PIM will win, and how accurately?
6. What is the best PIM configuration for a given workload and power budget?

### Novelty (what we claim)

We do **not** claim to invent PIM. Our contribution is:

1. An interactive, configurable CPU-vs-PIM simulator that models the costs PIM marketing usually leaves out: host-to-PIM copies, merging partial results through the host, launch and sync overhead, and load imbalance.
2. A **PIM Suitability Score** computed from the model and **validated** against simulated speedup over hundreds of configurations, with reported accuracy.
3. A **configuration optimiser** that recommends banks, PIM units and frequency under a power budget, and shows the time-vs-energy trade-off.

### In scope and out of scope

| In scope | Out of scope |
|---|---|
| Analytical (first-order) performance and energy model | Transistor or circuit-level DRAM simulation |
| 6 core workloads + 2 stretch workloads | Real PIM hardware, FPGA, Arduino, Raspberry Pi |
| Browser app (React + TypeScript) | Cycle-accurate simulation (mentioned as future work) |
| Experiments, CSV export, report figures | Compiler or ISA for PIM |

## 1. Key decisions and corrections

These decisions fix mistakes in the early reference notes and the dashboard mockup. Each one should be stated in the report, because each one makes the project more credible.

| # | Reference said | We do instead | Why |
|---|---|---|---|
| 1 | Matrix multiplication is "highly suitable" (87/100) for PIM | Headline workload is **matrix–vector multiply (GEMV)**. Dense matrix multiply (GEMM) is kept as the **counterexample** where the CPU wins | GEMM reuses each value many times (high arithmetic intensity), so CPU caches handle it well. PIM helps memory-bound work (PrIM, ETH Zürich) |
| 2 | T_PIM = PIM memory access + PIM compute + result transfer | Also model: copy-in, merging partial results via host, launch, sync, load imbalance | Without these costs PIM always wins, and the simulator is not believable |
| 3 | T_CPU = transfer + access + compute (added together) | T_CPU = max(memory time, compute time) | Modern CPUs overlap memory and compute |
| 4 | Only one "memory latency" input | Separate bandwidth (streaming) and latency (random access) terms | Vector add is limited by bandwidth; search and graphs are limited by latency |
| 5 | 8 memory banks | Banks slider 1 → 4,096 on a log scale, plus presets | A real UPMEM system has 2,560 PIM cores |
| 6 | React + FastAPI backend + Python engine | Engine in **TypeScript in the browser**; Python only for optional report plots | Instant slider response like PhET, no server, deploys as one link |
| 7 | Suitability score with fixed hand-picked weights | Factors computed from the model; weights fitted and accuracy reported | An unvalidated score is an opinion; a validated one is a result |
| 8 | Bank utilisation chart shows CPU mode higher than PIM | In CPU mode banks are mostly **idle** because the bus is the bottleneck; in PIM mode they are busy | That is the core PIM insight, so the chart should show it |

## 2. Phase overview

| Phase | Name | Week | Main deliverable |
|---|---|---|---|
| 0 | Setup and learning | 1 | Notes on fundamentals, repo created |
| 1 | Model specification | 1 | 4-page model spec + hand-worked example |
| 2 | Simulation engine | 2 | TypeScript engine + passing unit tests |
| 3 | UI shell | 3 | Working controls → live results table |
| 4 | Visualisations | 4 | Animated datapath, graphs, roofline, energy, bank utilisation |
| 5 | Experiments page | 5 | 10 experiments with charts and CSV export |
| 6 | Smart features | 5 | Validated Suitability Score + optimiser |
| 7 | Validation and presets | 5–6 | Validation section with evidence |
| 8 | Learn / About, polish, deploy | 6 | Public link to the finished simulator |
| 9 | Report, slides, demo | 6 | Report, PPT, rehearsed 5-minute demo |

Suggested calendar (adjust to the real deadline):

| Week | Dates |
|---|---|
| 1 | 28 Oct – 3 Nov |
| 2 | 4 Nov – 10 Nov |
| 3 | 11 Nov – 17 Nov |
| 4 | 18 Nov – 24 Nov |
| 5 | 25 Nov – 1 Dec |
| 6 | 2 Dec – 8 Dec |

If time is short, cut in this order: Learn page → optimiser Pareto chart → stretch workloads (Histogram, BFS) → Python plots.

## Phase 0: Setup and learning (Week 1, days 1–3)

**Goal:** understand enough architecture to explain every number the simulator produces.

### Learn, in this order

| Topic | What you must be able to explain |
|---|---|
| CPU, registers, cache, RAM | Why the CPU waits for memory |
| Latency vs bandwidth vs throughput | Latency = time for one request; bandwidth = bytes per second; throughput = operations per second |
| DRAM organisation | Channel → rank → chip → bank → row; row buffer |
| Memory wall | Compute has grown much faster than memory bandwidth |
| Arithmetic intensity and roofline | ops/byte; ridge point = peak compute ÷ bandwidth; left of ridge = memory-bound |
| PIM types | Processing-near-memory (logic beside banks: UPMEM, HBM-PIM, AiM) vs processing-using-memory (computing with the DRAM cells: RowClone, Ambit) |
| Real PIM hardware | UPMEM (2,560 DPUs), Samsung HBM-PIM, SK hynix GDDR6-AiM, Samsung LPDDR5X-PIM |
| Key findings | PrIM: PIM beats CPU on memory-bound workloads; UPMEM is compute-bound inside; no direct communication between PIM cores |

### Resources

- Onur Mutlu's ETH Zürich Computer Architecture lectures on Processing-in-Memory (YouTube).
- Mutlu et al., *A Modern Primer on Processing in Memory* (arXiv 2012.03112). Read the introduction and the UPMEM section.
- Gómez-Luna et al., *Benchmarking a New Paradigm: PrIM* (arXiv 2105.03814). Read the abstract, workload table and key takeaways.
- Williams, Waterman, Patterson, *Roofline: An Insightful Visual Performance Model* (CACM 2009).
- Hennessy & Patterson, *Computer Architecture: A Quantitative Approach*, memory hierarchy chapter.

### Setup tasks

- [ ] Install Node.js (LTS), VS Code, Git.
- [ ] Create the repo: `npm create vite@latest pim-simulator -- --template react-ts`
- [ ] Add Tailwind CSS, Recharts, Framer Motion, Vitest.
- [ ] Create the folder structure in Appendix E.
- [ ] Keep a `notes/` folder with one page per topic above.

**Done when:** you can explain the roofline chart and the "copy-in cost" idea without notes.

## Phase 1: Model specification (Week 1, days 4–7)

**Goal:** freeze the model on paper before writing any code.

### Tasks

- [ ] Write the parameter table (Appendix B) with units, defaults and a source or "assumption" note for each.
- [ ] Write the workload table (Appendix C): bytes per element, ops per element, pattern, output, merge cost, syncs.
- [ ] Write the equations (Appendix A).
- [ ] Solve the worked example below by hand or in Excel.
- [ ] Define every output metric precisely.
- [ ] Write the list of limitations (Appendix A, end).

### Worked example (must match the engine later)

Vector Add, mockup defaults, 134,217,728 int32 elements (1 GiB input, 512 MiB output):

| Step | Calculation | Result |
|---|---|---|
| CPU bytes moved | 12 B × 134.2 M | 1.61 GB |
| CPU memory time | 1.61 GB ÷ 25 GB/s | 64.4 ms |
| CPU compute time | 134.2 M ÷ (8 × 3.5 GHz × 4) | 1.2 ms |
| **T_CPU** | max(64.4, 1.2) | **64.4 ms** (memory-bound) |
| PIM bytes per unit | 1.61 GB ÷ 8 units | 201 MB |
| PIM bank time | 201 MB ÷ 8 GB/s | 25.2 ms |
| PIM compute time | 16.8 M ops ÷ 1 GOPS | 16.8 ms |
| **T_PIM (data resident)** | max(25.2, 16.8) + 0.05 launch | **≈ 25.2 ms → speedup 2.56×** |
| Copy-in + copy-out | 1.07 GB ÷ 25 + 0.54 GB ÷ 25 | 42.9 + 21.5 ms |
| **T_PIM (data copied)** | 25.2 + 42.9 + 21.5 | **89.6 ms → speedup 0.72× (PIM loses)** |
| Break-even runs | (42.9 + 21.5) ÷ (64.4 − 25.2) | ≈ 1.6, so PIM wins from run 2 |
| CPU data-movement energy | 1.61 GB × 160 pJ/B | 0.26 J |
| PIM in-bank energy | 1.61 GB × 25 pJ/B | 0.04 J |

**Done when:** the spec is written, the example is solved, and you can defend every default value.

## Phase 2: Simulation engine (Week 2)

**Goal:** a pure TypeScript engine with no UI code, fully tested.

### Tasks

- [ ] `params.ts`: `Params` type, defaults, three presets (Simple, UPMEM-like, HBM-PIM-like).
- [ ] `workloads.ts`: the 6 core workload descriptors (+ 2 stretch later).
- [ ] `cpuModel.ts`: streaming time, random-access time, compute time, `max()`.
- [ ] `pimModel.ts`: copy-in, launch, kernel (bank vs compute), merge, copy-out, syncs, imbalance.
- [ ] `energy.ts`: off-chip, in-bank, compute, static energy for both machines.
- [ ] `simulate.ts`: combines everything and returns `Result` (Appendix D), including a phase timeline for the animation.
- [ ] `bankUtilization.ts`: per-bank busy percentage for CPU mode and PIM mode.
- [ ] `sweep.ts`: run `simulate()` while varying one parameter; return rows for charts and CSV.
- [ ] `format.ts`: time (µs/ms/s), bytes (KB/MB/GB), energy (µJ/mJ/J), speedup (×).

### Unit tests (`tests/engine.test.ts`)

- [ ] Worked example from Phase 1 matches within 1%.
- [ ] Doubling data size roughly doubles both T_CPU and T_PIM for streaming workloads.
- [ ] With 1 PIM unit, PIM time equals the serial time of one unit.
- [ ] Turning off "data resident" adds exactly input_bytes ÷ copy bandwidth.
- [ ] GEMM is faster on the CPU with the default preset.
- [ ] Reduction speedup stops growing at high unit counts (merge cost).
- [ ] All outputs are finite and positive for every workload across the full slider ranges.
- [ ] Energy saving = (E_CPU − E_PIM) ÷ E_CPU.

**Done when:** `npm test` passes and a console script prints a results table for all workloads.

## Phase 3: UI shell (Week 3)

**Goal:** the mockup layout working with live numbers (no animation yet).

### Layout (from the mockup)

```text
┌───────────────────────── Header: title · nav · theme toggle ─────────────────────────┐
│ Simulation Controls │  Tabs: Architecture · Performance · Memory · Energy │ Results  │
│  1. Workload        │                                                     │ table    │
│  2. Data            │          (Phase 4: animated datapath)               │ Quick    │
│  3. Architecture    │                                                     │ compare  │
│  [Run] [Reset]      │                                                     │          │
├─────────────────────┴───────────────┬─────────────────────┬───────────────┴──────────┤
│ Performance Graphs (5 metric tabs)  │ Memory Bank Util.   │ PIM Suitability          │
└─────────────────────────────────────┴─────────────────────┴──────────────────────────┘
```

### Tasks

- [ ] `ControlsPanel.tsx`: workload dropdown, data-size log slider (1 KB → 10 GB), all parameters with units and tooltips (ⓘ), preset dropdown, "data already in PIM memory" toggle, Run and Reset.
- [ ] Global state with `useReducer` (or Zustand). Every change re-runs `simulate()`; debounce slider drags (~50 ms).
- [ ] `ResultsTable.tsx`: CPU vs PIM rows for execution time, speedup, data movement, memory accesses, energy, energy saving, throughput. Winner highlighted green, loser red.
- [ ] `QuickComparison.tsx`: horizontal bars for time, data movement, energy.
- [ ] `PerformanceGraphs.tsx`: line chart of metric vs data size (log–log), with tabs for time, speedup, data movement, energy, throughput.
- [ ] "What limits each machine" chips: memory-bound, compute-bound, copy-bound, communication-bound.
- [ ] Dark and light themes; responsive down to laptop width.

**Done when:** moving any slider updates every number and chart instantly.

## Phase 4: Visualisations (Week 4)

**Goal:** the PhET-style "see it happen" part.

### Tasks

- [ ] `ArchitectureViz.tsx`, side by side:
  - **CPU side:** CPU → memory controller → banks. Many packets stream up the bus; banks light up one after another.
  - **PIM side:** CPU sends a small command; every bank's PIM unit pulses at the same time; only results travel back.
  - Phases come from the engine timeline: copy-in → compute → merge → copy-out.
  - A simulated-time clock under each side; short phases are stretched so they stay visible.
  - Legend: data read, data write, computation, command, result.
- [ ] `BankUtilization.tsx`: per-bank busy % for CPU mode vs PIM mode (shows idle banks in CPU mode and load imbalance in PIM mode).
- [ ] `Roofline.tsx`: CPU roof, PIM roof, workload's arithmetic intensity line, achieved points (log–log).
- [ ] `TimeBreakdown.tsx`: stacked bars (CPU compute, CPU waiting on memory, copy-in, PIM compute, PIM waiting on bank, merge, copy-out, launch).
- [ ] `EnergyBreakdown.tsx`: stacked bars (off-chip movement, in-bank access, compute, static).
- [ ] Respect `prefers-reduced-motion` (show the final frame instead of animating).

**Done when:** a non-expert can watch one run and say why PIM was faster or slower.

## Phase 5: Experiments page (Week 5, first half)

**Goal:** turn the simulator into a research tool.

### Tasks

- [ ] Experiment runner: pick an experiment, pick workloads, Run, and get a chart, a table and a **Download CSV** button.
- [ ] Implement the 10 experiments in Appendix F.
- [ ] Each experiment card shows the question, the chart and a one-paragraph observation (written by you after running it).
- [ ] Save the CSVs into `results/` for the report.

**Done when:** all 10 experiments produce charts and CSVs, and each has a written observation.

## Phase 6: Smart features (Week 5, second half)

### 6A. PIM Suitability Score

Four factors, each 0 to 1, computed from the model:

| Factor | Formula | Meaning |
|---|---|---|
| Memory intensity | 1 − min(1, AI ÷ ridge_CPU) | How memory-bound the workload is on the CPU |
| Parallelism | 1 − (T_merge + syncs·T_sync) ÷ T_PIM | How little time goes to communication |
| Data movement saved | 1 − PIM_offchip_bytes ÷ CPU_offchip_bytes | How much bus traffic PIM removes |
| Compute fit | min(1, T_bank ÷ T_pim_compute) | Whether the PIM cores are strong enough |

Score = 100 × (w1·f1 + w2·f2 + w3·f3 + w4·f4), with w summing to 1.

Validation tasks:

- [ ] Generate about 500 random configurations (workload, size, banks, bandwidth, latency, resident or not).
- [ ] For each, record the score and the true simulated speedup.
- [ ] Compute Spearman rank correlation between score and log(speedup).
- [ ] Fit the weights with logistic regression (label = speedup > 1). This can be done in TypeScript or Python.
- [ ] Report accuracy, e.g. "score ≥ 60 predicts a PIM win in X% of configurations".
- [ ] UI: gauge (0–100), factor bars, label (Highly suitable / Moderately suitable / Not suitable), recommendation text.

### 6B. Configuration optimiser

- [ ] Search space: banks {1 … 4,096} × units per bank {1, 2, 4} × PIM frequency {0.35, 0.5, 1.0, 1.5 GHz}.
- [ ] Constraint: power budget (each PIM unit costs a set number of watts).
- [ ] Objective selector: minimum time, minimum energy, or minimum energy × delay.
- [ ] Output: recommended configuration, expected speedup and energy saving.
- [ ] Pareto chart: time vs energy, recommended point highlighted.

**Done when:** the score's accuracy is measured and the optimiser recommends sensible configurations (for example, it should not recommend PIM for GEMM).

## Phase 7: Validation and presets (Week 5–6)

**Goal:** evidence that the numbers are reasonable.

- [ ] **Sanity tests:** all Phase 2 unit tests pass.
- [ ] **UPMEM-like preset vs PrIM trends:** PIM beats the CPU on vector add, reduction, select and GEMV; loses on GEMM; scaling flattens on reduction and histogram; copies dominate when data is not resident.
- [ ] **HBM-PIM-like preset vs Samsung's claim:** about 2× performance and about 70% lower power for memory-bound kernels.
- [ ] **Cross-check:** compare a few configurations against the earlier PIMscope reference simulator.
- [ ] **Sensitivity check:** change each assumed energy value by ±50% and confirm the conclusions do not flip (or state where they do).
- [ ] Write a validation table for the report: claim, source, simulator value, match (yes/partly/no).

**Done when:** the validation table is complete.

## Phase 8: Learn / About, polish, deploy (Week 6, first half)

- [ ] **Learn page:** memory wall, CPU vs PIM diagram, roofline explained, PIM types, real hardware, glossary.
- [ ] **About page:** team, course, model limitations, references.
- [ ] **Results page:** saved runs side by side.
- [ ] Polish: tooltips on every parameter, keyboard focus, loading states, empty states, consistent number formats.
- [ ] Deploy to Vercel or GitHub Pages; test the link on another laptop and a phone.
- [ ] Write the README: what it is, how to run, how the model works, screenshots.

**Done when:** sir can open one link and use the simulator without you.

## Phase 9: Report, slides, demo (Week 6, second half)

- [ ] Report (outline in Appendix H), with figures from the Experiments CSVs.
- [ ] Slides: 12–15 slides (problem → PIM idea → model → demo → results → score → conclusion).
- [ ] Rehearse the 5-minute demo script (Appendix G) twice.
- [ ] Prepare for viva questions (Appendix I).
- [ ] Back-up plan: screen recording of the demo in case of network issues.

**Done when:** the report, slides and demo are complete and rehearsed.

## Appendix A: Equations

```text
Notation
  n            elements
  P            PIM units = banks × units_per_bank
  B_r, B_w     bytes read / written per element
  W            operations per element
  c            PIM cost per op = (1 − mul_frac) + mul_frac × mul_cost
  AI           arithmetic intensity = W ÷ (B_r + B_w)

CPU
  T_stream   = n·(B_r + B_w) ÷ BW_mem
  T_random   = n·R·latency ÷ (cores × MLP)        R = random accesses per element
  T_compute  = n·W ÷ (cores × f_cpu × ops_per_cycle)
  T_CPU      = max(T_stream + T_random, T_compute)

PIM
  T_in       = resident ? 0 : input_bytes ÷ BW_copy
  work       = (n ÷ P) × imbalance
  T_bank     = work·(B_r + B_w) ÷ BW_bank + work·R·t_bank_random
  T_pcomp    = work·W·c ÷ (f_pim × ops_per_cycle_pim)
  T_kernel   = max(T_bank, T_pcomp)
  T_merge    = P·partial_bytes ÷ BW_copy + P·merge_ops ÷ CPU_rate
  T_out      = result_needed_on_host ? output_bytes ÷ BW_copy : 0
  T_PIM      = T_in + T_launch + T_kernel + T_merge + T_out + syncs·T_sync

Metrics
  Speedup           = T_CPU ÷ T_PIM
  Data movement     CPU = n·(B_r + B_w)        PIM = input + output + merge bytes
  Memory accesses   CPU = data movement ÷ 64 B (cache lines)
                    PIM = n·(B_r + B_w) ÷ bank access size
  Throughput        = n·W ÷ T
  E_CPU = n·(B_r+B_w)·e_offchip + n·W·e_cpu_op + P_cpu_static·T_CPU
  E_PIM = (in+out+merge bytes)·e_offchip + n·(B_r+B_w)·e_inbank
        + n·W·c·e_pim_op + merge_ops·e_cpu_op + (P·P_unit + P_cpu_idle)·T_PIM
  Energy saving     = (E_CPU − E_PIM) ÷ E_CPU × 100 %
  Break-even runs   = (T_in + T_out) ÷ (T_CPU − T_kernel)     (only if T_CPU > T_kernel)

Bank utilisation
  CPU mode:  busy_b = (bytes on bank b ÷ BW_bank) ÷ T_CPU
  PIM mode:  busy_u = T_kernel_u ÷ T_PIM
```

**Model limitations (state these in the report):** first-order analytical model; no row-buffer conflicts, refresh, cache hierarchy detail or memory-controller scheduling; energy values for in-bank access and PIM ops are assumptions; results show trends, not exact hardware timings.

## Appendix B: Parameters and presets

| Parameter | Unit | Simple (mockup) | UPMEM-like | HBM-PIM-like |
|---|---|---|---|---|
| CPU frequency | GHz | 3.5 | 3.3 | 1.4 (GPU host) |
| CPU cores | – | 8 | 4 | 108 |
| CPU ops per cycle | – | 4 | 8 | 128 |
| Memory bandwidth | GB/s | 25 | 38.4 | 1,200 |
| Memory latency | ns | 100 | 100 | 120 |
| Outstanding misses per core (MLP) | – | 10 | 10 | 64 |
| Memory banks | – | 8 | 2,560 | 512 |
| PIM units per bank | – | 1 | 1 | 1 |
| PIM frequency | GHz | 1.0 | 0.35 | 0.3 |
| PIM ops per cycle | – | 1 | 0.166 (≈ 58 MOPS add) | 16 |
| Bank internal bandwidth per unit | GB/s | 8 | 0.63 | 9.4 |
| Host↔PIM copy bandwidth | GB/s | 25 | 6 | 1,200 |
| Multiply cost (× add) | – | 1 | 5.7 | 1 |
| Launch overhead | µs | 50 | 50 | 5 |
| Sync latency | µs | 20 | 20 | 2 |
| Off-chip energy | pJ/byte | 160 | 160 | 31 |
| In-bank energy | pJ/byte | 25 | 25 | 8 |
| CPU energy per op | pJ | 40 | 40 | 8 |
| PIM energy per op | pJ | 10 | 10 | 3 |
| CPU static power while running | W | 65 | 65 | 150 |
| CPU idle power while PIM runs | W | 15 | 15 | 60 |
| Power per PIM unit | W | 0.06 | 0.06 | 0.02 |

Sources: UPMEM values approximate PrIM measurements (Gómez-Luna et al.); HBM-PIM values are modelled on Samsung Aquabolt-XL; the off-chip energy is in the range reported for DDR access (Horowitz, ISSCC 2014). Everything marked "assumption" in the spec is editable in the UI.

## Appendix C: Workloads

| ID | Workload | B_r + B_w | W (ops) | Pattern | Merge / communication | Expected |
|---|---|---|---|---|---|---|
| VA | Vector Add `C = A + B` | 8 + 4 | 1 add | Streaming | None | PIM wins |
| VM | Vector Multiply `C = A × B` | 8 + 4 | 1 multiply | Streaming | None | PIM wins; smaller gain with UPMEM preset |
| RED | Reduction (sum) | 4 + 0 | 1 add | Streaming | 1 partial per unit merged on host | Wins, then flattens with many units |
| SEL | Search / Select | 4 + ~0.4 | 2 | Streaming, tiny output | Match counts per unit | Strong PIM case |
| GEMV | Matrix–vector `y = A·x` | 4 + ~0 | 2 (mul+add) | Streaming | Vector x copied to every unit | PIM wins (headline) |
| GEMM | Matrix multiply (tiled) | 8·N³ ÷ tile bytes | 2N³ total | High reuse | None | **CPU wins** (counterexample) |
| HST* | Histogram (256 bins) | 4 + 0 | 3 | Streaming | 256-bin partial per unit | Communication-limited |
| BFS* | Breadth-first search | 8 + 0 | 2 | Random | Frontier exchange every level | Latency and sync limited |

\* stretch workloads.

## Appendix D: Core TypeScript types

```ts
export interface Params {
  cpu: { freqGHz: number; cores: number; opsPerCycle: number;
         memBWGBs: number; memLatencyNs: number; mlp: number };
  pim: { banks: number; unitsPerBank: number; freqGHz: number; opsPerCycle: number;
         bankBWGBs: number; copyBWGBs: number; mulCost: number;
         launchUs: number; syncUs: number };
  energy: { offchipPJperB: number; inbankPJperB: number; cpuPJperOp: number;
            pimPJperOp: number; cpuStaticW: number; cpuIdleW: number; pimUnitW: number };
  dataResident: boolean;
  resultNeededOnHost: boolean;
}

export interface Workload {
  id: string; name: string; description: string;
  bytesReadPerElem: number; bytesWrittenPerElem: number;
  opsPerElem: number; mulFraction: number;
  randomAccessesPerElem: number;
  inputBytes: (n: number, P: number) => number;
  outputBytes: (n: number, P: number) => number;
  partialBytesPerUnit: (n: number, P: number) => number;
  mergeOpsPerUnit: (n: number, P: number) => number;
  syncs: number; imbalance: number;
}

export type Phase = { name: string; kind: 'copyIn' | 'kernel' | 'merge' | 'copyOut' | 'stream';
                      seconds: number };

export interface Result {
  cpu: { time: number; memTime: number; computeTime: number; bytes: number;
         accesses: number; energy: EnergyParts; throughput: number;
         bound: 'memory' | 'compute' };
  pim: { time: number; copyIn: number; kernel: number; bankTime: number; computeTime: number;
         merge: number; copyOut: number; overhead: number; bytesOffchip: number;
         accesses: number; energy: EnergyParts; throughput: number;
         bound: 'copy' | 'bank' | 'compute' | 'communication' | 'overhead' };
  speedup: number; energySaving: number; arithmeticIntensity: number;
  breakEvenRuns: number | null;
  timeline: { cpu: Phase[]; pim: Phase[] };
}

export type EnergyParts = { movement: number; inBank: number; compute: number; static: number };
```

## Appendix E: Folder structure

```text
pim-simulator/
├── src/
│   ├── engine/
│   │   ├── params.ts          defaults + 3 presets
│   │   ├── workloads.ts       workload descriptors
│   │   ├── cpuModel.ts
│   │   ├── pimModel.ts
│   │   ├── energy.ts
│   │   ├── simulate.ts        → Result
│   │   ├── bankUtilization.ts
│   │   ├── sweep.ts           experiments
│   │   ├── suitability.ts
│   │   ├── optimizer.ts
│   │   └── format.ts
│   ├── components/
│   │   ├── ControlsPanel.tsx
│   │   ├── ArchitectureViz.tsx
│   │   ├── ResultsTable.tsx
│   │   ├── QuickComparison.tsx
│   │   ├── PerformanceGraphs.tsx
│   │   ├── TimeBreakdown.tsx
│   │   ├── EnergyBreakdown.tsx
│   │   ├── Roofline.tsx
│   │   ├── BankUtilization.tsx
│   │   └── SuitabilityCard.tsx
│   ├── pages/
│   │   ├── Simulator.tsx
│   │   ├── Experiments.tsx
│   │   ├── Results.tsx
│   │   ├── Learn.tsx
│   │   └── About.tsx
│   ├── state/store.ts
│   └── App.tsx
├── tests/engine.test.ts
├── results/                   CSVs from experiments
├── python/                    optional: report plots, score fitting
├── notes/                     learning notes (Phase 0)
├── docs/model-spec.md         Phase 1 spec
└── README.md
```

## Appendix F: Experiments

| # | Experiment | Sweep | Question | Expected observation |
|---|---|---|---|---|
| E1 | Data size | 1 KB → 10 GB | Is there a minimum size for PIM to help? | PIM loses on small data (launch overhead); crossover size exists |
| E2 | PIM unit count | 1 → 4,096 | Does PIM scale? | Near-linear for VA/SEL; flattens or drops for RED/HST |
| E3 | CPU memory bandwidth | 12.5 → 200 GB/s | How strong must the CPU be to beat PIM? | PIM's advantage shrinks as bandwidth grows |
| E4 | Memory latency | 50 → 300 ns | Who suffers from latency? | CPU on random-access workloads; little effect on streaming |
| E5 | Workload comparison | 6–8 workloads | Which workloads suit PIM? | Memory-bound win; GEMM loses |
| E6 | Data placement | resident vs copied, 1–10 runs | When does copying pay back? | Break-even after a small number of runs |
| E7 | PIM compute strength | freq 0.35 → 1.5 GHz; mul cost 1 → 6 | Are PIM cores the bottleneck? | VM and GEMV sensitive with UPMEM preset |
| E8 | Energy breakdown | all workloads | Where does energy go? | Off-chip movement dominates CPU energy |
| E9 | Score validation | ~500 random configs | Can a score predict PIM wins? | Report correlation and accuracy |
| E10 | Optimiser | config grid under power budget | What is the best design? | Pareto front; recommendation per workload |

## Appendix G: 5-minute demo script

1. **Vector Add, default settings, Run.** The CPU bus is flooded with packets while all PIM banks work in parallel. Result about 2.5× faster with less energy.
2. **Untick "data already in PIM memory".** PIM now loses. Show the break-even runs value.
3. **Switch to Matrix Multiply.** The CPU wins. Open the roofline: GEMM is to the right of the ridge, so it is compute-bound.
4. **Reduction, drag the PIM units slider up.** Speedup flattens because every partial result merges through the host.
5. **Suitability panel.** Show the score, the factor bars, the validation accuracy and the optimiser's recommended configuration.

## Appendix H: Report outline

1. Introduction: memory wall, motivation, research question, objectives, scope.
2. Background: DRAM organisation, roofline, PIM types, real hardware (UPMEM, HBM-PIM, AiM, LPDDR5X-PIM).
3. Literature review: PrIM benchmarks, uPIMulator, Ramulator-PIM, PIM simulation surveys.
4. Simulator design: architecture diagram, equations, parameters, workloads.
5. Implementation: tech stack, modules, UI, animation.
6. Validation: unit tests, comparison with published trends, sensitivity analysis.
7. Experiments and results: E1–E10 with figures and observations.
8. Suitability Score and Optimiser: method, validation accuracy, recommendations.
9. Limitations.
10. Conclusion and future work: cycle-level simulation, CXL-attached memory, PIM for LLM inference, processing-using-memory.
11. References.

## Appendix I: Viva questions to prepare

| Question | Short answer |
|---|---|
| What is the memory wall? | CPU speed grew far faster than memory bandwidth, so CPUs spend much of their time waiting for data |
| Why is GEMM bad for PIM? | High data reuse; caches already cut memory traffic; PIM cores are weak at compute |
| Why does PIM lose when data must be copied in? | The copy crosses the same narrow bus PIM was meant to avoid |
| Why does reduction stop scaling? | Partial results from every unit are merged through the host; that cost grows with unit count |
| What is arithmetic intensity? | Operations per byte moved; below the ridge point a workload is memory-bound |
| Why is UPMEM compute-bound internally? | Simple in-order cores at ~350 MHz, 32-bit multiply in software |
| How did you validate the simulator? | Unit tests, a hand-worked example, and comparison with published PrIM and Samsung trends |
| What are your model's limitations? | First-order; no row-buffer conflicts, refresh, cache detail; some energy values assumed |
| How is your score different from a guess? | Factors come from the model, and the weights are fitted and tested on hundreds of configurations |
| Near-memory vs using-memory PIM? | Near-memory adds logic beside banks; using-memory computes with the DRAM cells (e.g. bulk copy, bitwise ops) |

## Appendix J: References

1. J. Gómez-Luna et al., "Benchmarking a New Paradigm: Experimental Analysis and Characterization of a Real Processing-in-Memory System," IEEE Access, 2022. arXiv:2105.03814.
2. O. Mutlu et al., "A Modern Primer on Processing in Memory," arXiv:2012.03112.
3. B. Hyun et al., "Pathfinding Future PIM Architectures by Demystifying a Commercial PIM Technology" (uPIMulator), HPCA 2024. arXiv:2308.00846.
4. CMU SAFARI, Ramulator-PIM, github.com/CMU-SAFARI/ramulator-pim.
5. "Modeling and Simulation Frameworks for Processing-in-Memory Architectures," arXiv:2512.00096, 2025.
6. S. Lee et al., "Hardware Architecture and Software Stack for PIM Based on Commercial DRAM Technology" (Samsung HBM-PIM / Aquabolt-XL), ISCA 2021.
7. S. Williams, A. Waterman, D. Patterson, "Roofline: An Insightful Visual Performance Model for Multicore Architectures," CACM, 2009.
8. M. Horowitz, "Computing's Energy Problem (and what we can do about it)," ISSCC 2014.
9. J. Hennessy, D. Patterson, *Computer Architecture: A Quantitative Approach*, 6th ed.
