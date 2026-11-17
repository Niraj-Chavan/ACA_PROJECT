# Project Guide — PIM Architecture Simulator & Real UPMEM Kernels

**Course:** Advanced Computer Architecture  
**Project:** *Processing-in-Memory (PIM) Architecture Simulator and Performance Analysis*  
**Repository:** `github.com:Niraj-Chavan/ACA_PROJECT`

---

## How to use this guide

This document is written for someone who has to **explain and demo the project to a
professor**, even if they did not build it. It contains:

1. **What the project is** (one-paragraph answer).
2. **Theory and definitions** — every term you may be asked about.
3. **How the project is built** — architecture and file map.
4. **The model equations** — what the simulator computes.
5. **The real UPMEM kernels** — what they do and what was measured.
6. **The Scheduler and Algorithm Lab** — the five upgrades added later.
7. **Exact run instructions** — dashboard, bridge, SDK kernels, tests.
8. **A scripted demo for the professor** — click-by-click, with what to say.
9. **Likely viva questions and short answers.**
10. **Limitations and troubleshooting.**
11. **Work division among 4 members** — who owns which files, minutes and answers.

If you only read one thing before the demo, read [§8 Demo script](#8-demo-script-for-the-professor),
[§9 Viva cheat sheet](#9-viva-cheat-sheet-questions--answers) and
[§11 Work division](#11-work-division-among-4-team-members).

---

## 1. What the project is

> We built an interactive **CPU vs Processing-in-Memory (PIM) performance and energy
> explorer**, plus **six real kernels compiled to the UPMEM DPU instruction set**.
> The simulator answers: *for a given workload and memory configuration, when does
> PIM beat a CPU, by how much, and what limits it?* Every simulated number is
> decomposed into the formula that produced it. The real kernels run in the UPMEM
> SDK functional simulator and their measured cycle counts calibrate the model.

The project answers the question in **two independent ways**:

| Path | What it is | Where it lives |
|---|---|---|
| **Analytical model** | Pure TypeScript formulas; instant, editable, fully traceable | `pim-simulator/src/engine/` |
| **Real DPU execution** | C kernels compiled with `dpu-upmem-dpurte-clang`, run by the UPMEM SDK runtime, measured with on-chip perfcounters | `pim-kernels/` |

A small Node bridge (`pim-simulator/bridge/server.mjs`) connects the browser to the
SDK so you can launch kernels from the **Live DPU** page and stream events back over
SSE.

**Important honesty note:** there is **no physical UPMEM board attached**. The SDK
runs in *functional-simulator* mode: DPU instructions really execute and the cycle
counter is real, but host wall-clock time includes simulation overhead and is not
silicon timing. Always say this in the demo.

---

## 2. Theory and definitions

### 2.1 The memory wall

CPU compute improved much faster than DRAM bandwidth and latency. A modern core can
retire several operations per cycle, but a DRAM access takes ~100 ns — hundreds of
cycles. For streaming workloads the CPU spends most of its time **moving data**, not
computing. PIM addresses this by putting simple compute logic next to (or inside)
memory, so data is consumed where it is stored.

### 2.2 Processing-in-Memory (PIM)

**PIM** = performing computation in or near memory instead of moving all data to the
CPU cache registers. Two families:

- **Near-memory / near-bank PIM:** logic is placed next to DRAM banks or memory
  chips (UPMEM DPUs, Samsung HBM-PIM). Data is transferred over a short internal
  path, often via DMA, into local memory next to the cores.
- **Using-memory / in-DRAM PIM:** the DRAM array itself performs operations
  (bulk copy, bitwise AND/OR, row copy). Less flexible, very high internal bandwidth.

This project models near-memory PIM and runs real UPMEM DPU kernels.

### 2.3 UPMEM DPU hardware model

```text
Host CPU + DRAM
      │  copy-in / copy-out through the SDK runtime
      ▼
┌────────────────── DPU set ──────────────────┐
│  DPU 0        DPU 1        …        DPU N   │
│  64 MiB MRAM  64 MiB MRAM            64 MiB  │
│  16 banks     16 banks                      │
│     │ 256 B DMA bursts                      │
│  64 KiB WRAM  64 KiB WRAM                    │
│     │                                       │
│  16 tasklets  16 tasklets                   │
└──────────────────────────────────────────────┘
```

Term | Definition
---|---
**MRAM** | Main RAM on each DPU (~64 MiB), organised in banks. Resident input arrays live here. Access from tasklets requires explicit DMA.
**WRAM** | Small (~64 KiB) fast working memory shared by the 16 tasklets of one DPU. Data must be staged here from MRAM before use. There are no caches.
**DMA** | Direct memory access: a `mram_read`/`mram_write` moves a 256-byte block between MRAM and WRAM. Lengths must be multiples of 8 bytes.
**Tasklet** | One of 16 hardware threads on a DPU. They share WRAM and synchronise with explicit barriers.
**Barrier** | `barrier_wait()` — all tasklets must arrive before any continues. Used before reducing partial results.
**perfcounter** | On-chip cycle counter. `perfcounter_get()` gives the cycles of the critical (maximum) tasklet. This is the measured quantity in our results.
**Functional simulator** | The SDK executes the compiled DPU binary instruction-by-instruction on the host. Correct instruction execution + cycle counts; no real timing or bank contention.

### 2.4 Performance vocabulary

Term | Definition / formula
---|---
**Bandwidth (BW)** | Bytes transferred per second (GB/s). Two important ones: *copy BW* (host ↔ DPU) and *bank BW* (DPU ↔ its MRAM).
**Latency** | Time for one request to complete (ns). Important for random accesses.
**Arithmetic intensity (AI)** | Operations per byte moved. Low AI ⇒ memory-bound; high AI ⇒ compute-bound.
**Roofline** | Performance limit = min(peak compute, bandwidth × AI). Below the ridge point a workload is bandwidth-bound; above it compute-bound.
**Memory-bound** | Time is dominated by data movement (`T_mem > T_compute`).
**Compute-bound** | Time is dominated by arithmetic (`T_compute > T_mem`).
**Speedup** | `T_CPU / T_PIM`. >1 means PIM is faster.
**Energy saving** | `(E_CPU − E_PIM) / E_CPU × 100%`.
**Break-even runs** | How many times the same resident data must be reused before copying it into PIM pays off: `(T_copy-in + T_copy-out) / (T_CPU − T_kernel)`.
**Data resident** | Assumption that input data is already in PIM banks. Then `T_copy-in = 0` — the simulator shows **0 B moved**, which is an assumption, not a bug.
**Merge** | Combining partial results (one per DPU/unit) on the host. Its cost grows with unit count, so scaling flattens.
**Launch overhead** | ~50 µs to start a DPU kernel. On tiny workloads it dominates.
**Software multiply** | UPMEM has no hardware integer multiplier; one multiply costs several adds (≈3.33× an add, back-solved from GEMV).

### 2.5 Scheduling and memory vocabulary

Term | Meaning in this project
---|---
**Task** | A unit of work with a known kind (VA, GEMV, RED, SEARCH, HIST, GEMM), element count and CPU/PIM cost.
**Makespan** | Total time until the last task finishes.
**Utilisation** | Busy time / available time for a DPU lane. 100% means no idle gaps.
**Load balancing** | Assigning work so no lane sits idle while others are overloaded.
**LPT** | Longest Processing Time first — sort tasks by predicted duration before placing them.
**FCFS** | First come, first served, with a fixed PIM/CPU classifier.
**Round Robin** | Same classifier, but PIM tasks are dealt cyclically to lanes.
**Adaptive scheduling** | Cost-aware LPT: choose CPU vs PIM by predicted finish time, choose task width from data size, choose least-loaded lanes.
**Bank conflict** | Two tasks resident in the same logical bank over overlapping lifetimes (modelled).
**First Fit / Best Fit / Bank-aware** | Three logical bank allocation policies: pack low banks, fill tightest bank, or spread to avoid conflicts.

---

## 3. How the project is built

### 3.1 Architecture

```text
Browser (React + TypeScript)
 ├─ UI pages: Simulator, Scheduler, Algorithm Lab, Experiments, Results,
 │            PIM internals, Live DPU, Learn, About
 ├─ store.ts                 single immutable app state
 ├─ engine/                  analytical model + scheduler + memory + optimiser
 └─ state/live.ts            SSE client, event reducer, replay

Host machine
 └─ bridge/server.mjs        GET /api/run, /api/runs, /health
       └─ make + host C binary → UPMEM SDK runtime → DPU ISA execution
             └─ JSON events on stderr → SSE → browser → saved .jsonl

UPMEM SDK 2025.1 functional simulator
 └─ dpu-upmem-dpurte-clang, dpu_alloc/load/push_xfer/launch, perfcounter
```

### 3.2 Repository map

```text
ACA_PROJECT/
├── README.md                  main project README
├── PROJECT_GUIDE.md           this guide
├── PIM_Project_Plan.md        plan, equations, viva questions
├── upmem-env.example.sh       template for SDK environment
├── pim-simulator/
│   ├── src/engine/            model: params, workloads, cpuModel, pimModel,
│   │                          energy, simulate, trace, calibration, sweep,
│   │                          suitability, optimizer, format
│   │                          + scheduler: tasks, scheduler, memory,
│   │                            benchmark, optimize
│   ├── src/pages/             Simulator, Scheduler, Lab, Experiments,
│   │                          Results, Deep (PIM internals), Live, Learn, About
│   ├── src/components/        charts, tables, roofline, architecture view
│   ├── src/state/             store, hooks, live (SSE + replay)
│   ├── bridge/server.mjs      zero-dependency SSE bridge
│   ├── public/runs/           six bundled demo streams (replay without bridge)
│   ├── tests/                 engine.test.ts, trace.test.ts, scheduler.test.ts
│   └── docs/model-spec.md     compact model specification
└── pim-kernels/
    ├── common/                shared constants, result structs, JSON emitters
    ├── va/ gemv/ red/         original three kernels
    ├── search/ hist/ gemm/    three added kernels
    ├── runs/                  replayable measured event streams
    └── Makefile               make va | … | gemm | all | run_*
```

### 3.3 Dashboard pages

| Page | What it shows |
|---|---|
| **Simulator** | Workload/preset/data-size controls, datapath animation, results table, energy/time breakdowns, bank utilisation, suitability card, optimiser. Has the resident-data badge and cold-data toggle. |
| **Scheduler** | Five placement policies; tabs **Tasks / Timeline / Load / Memory / Compare**. Per-task reasons, Gantt, lane utilisation, logical banks. |
| **Algorithm Lab** | Tabs **Workloads / Scaling / Optimisation**. Runs the six real kernels, compares sequential vs modelled parallel, sweeps DPU count, chunk size and crossover. |
| **Experiments** | E1–E10 parameter sweeps with charts, CSV export and written observations. |
| **Results** | Performance graphs vs data size, roofline, CPU/PIM breakdowns, quick comparison. |
| **PIM internals** (code `Deep`) | DPU/MRAM/WRAM/DMA diagram, formula inspector (formula → substitution → explanation), calibration ledger, measured-runs table. |
| **Live DPU** | Kernel/DPU controls, build-and-run, stop/clear, demo and saved-run replay, file upload, phase timeline/table, measured-vs-model table, raw event stream. |
| **Learn** | Memory wall, memory hierarchy, roofline, PIM taxonomy, glossary. |
| **About** | Scope, contribution, limitations, references. |

---

## 4. The analytical model

All formulas are in `pim-simulator/src/engine/`. Units are seconds, bytes,
operations and joules; the UI formats them.

### 4.1 CPU model

```text
T_stream  = (B_read + B_written) / BW_mem
T_random  = (R × L) / (cores × MLP)
T_mem     = T_stream + T_random
T_compute = O / (cores × f_CPU × IPC_CPU)
T_CPU     = max(T_mem, T_compute)
```

The CPU overlaps memory and compute, so we take the **longer** of the two.

### 4.2 PIM model

```text
T_copy-in = input_bytes / BW_copy                 (0 if resident)
T_launch  = launch_us
T_bank    = kernel_bytes / BW_bank + (R / P) × 60 ns
f_mul     = O_mul / O
c         = (1 − f_mul) + f_mul × c_mul
T_pcomp   = (O / P × imbalance × c) / (f_PIM × IPC_PIM)
T_kernel  = max(T_bank, T_pcomp)
T_merge   = (P × partial_bytes) / BW_copy + (P × merge_ops) / 2 Gops/s
T_copy-out= output_bytes / BW_copy                 (0 if result stays in banks)
T_sync    = syncs × sync_us
T_PIM     = T_copy-in + T_launch + T_kernel + T_merge + T_copy-out + T_sync
```

`P = banks × units_per_bank`. Two consequences to explain in the viva:

- **Merge grows with P**, so reduction/histogram scaling flattens.
- **Multiply penalty `c`** makes GEMV/GEMM expensive on UPMEM cores.

### 4.3 Energy model

```text
CPU: E_move = bytes × e_offchip
     E_comp = O × e_cpu_op
     E_static = CPU_static_W × T_CPU

PIM: E_move = offchip_copy_bytes × e_offchip
     E_inbank = bytes × e_inbank
     E_comp = O × c × e_pim_op
     E_static = (CPU_idle_W + P × PIM_unit_W) × T_PIM
```

PIM saves energy because element traffic stays inside the memory banks; off-chip
movement is ~160 pJ/B vs ~25 pJ/B in-bank.

### 4.4 Derived metrics

```text
Speedup         = T_CPU / T_PIM
Energy saving   = (E_CPU − E_PIM) / E_CPU
Break-even runs = (T_copy-in + T_copy-out) / (T_CPU − T_kernel)
AI              = O / (bytes + R × 64 B)
```

### 4.5 Presets

| Preset | PIM units | PIM clock | Bank BW | Copy BW | Multiply cost |
|---|---:|---:|---:|---:|---:|
| Simple mockup (default) | 8 | 1.0 GHz | 8 GB/s | 25 GB/s | 1× |
| UPMEM-like | 2,560 | 0.35 GHz | 0.63 GB/s | 6 GB/s | 5.7× |
| HBM-PIM-like | 512 | 0.30 GHz | 9.4 GB/s | 1,200 GB/s | 1× |

The default preset has `dataResident = true` and `resultNeededOnHost = false`;
this is why the Simulator shows **0 B** of copy-in and copy-out for PIM.

### 4.6 Workloads in the simulator

| Workload | Shape | Why it matters |
|---|---|---|
| Vector Add (VA) | `C = A + B` | Pure streaming; best PIM case |
| Vector Multiply (VM) | `C = A × B` | Same traffic, but multiply-heavy |
| Reduction (RED) | sum of array | Merge term limits scaling |
| Search/Select (SEL) | count matches | Tiny output; strong PIM case |
| GEMV | `y = A·x` | Low reuse; headline PIM workload |
| GEMM | `C = A·B` | High reuse; CPU wins |
| Histogram (HST) * | 256 bins | Scatter + merge |
| BFS * | graph traversal | Random accesses + sync; hardest case |

`*` = stretch workload.

### 4.7 The ten guided experiments

| # | Sweep | Question |
|---|---|---|
| E1 | Data size 1 KB → 10 GB | Is there a minimum size for PIM to help? |
| E2 | PIM units 1 → 4,096 | Does PIM scale? |
| E3 | CPU memory bandwidth | How strong must the CPU be to beat PIM? |
| E4 | Memory latency | Who suffers from latency? |
| E5 | Workload comparison | Which workloads suit PIM? |
| E6 | Data placement / runs | When does copying data in pay back? |
| E7 | PIM clock and multiply cost | Are PIM cores the bottleneck? |
| E8 | Energy breakdown | Where does energy go? |
| E9 | ~500 random configurations | Can a score predict PIM wins? |
| E10 | Configuration grid | What is the best design under a power budget? |

### 4.8 Suitability score

Four model-derived factors, default weights **0.35 / 0.25 / 0.25 / 0.15**:

- `memoryIntensity` — how far below the CPU ridge point the workload is;
- `parallelism` — `1 − (merge + sync) / T_PIM`;
- `dataMovementSaved` — `1 − PIM off-chip bytes / CPU bytes`;
- `computeFit` — `min(1, T_bank / T_pcomp)`.

Weights are fitted by logistic regression on ~500 random configurations with the
label `speedup > 1`; the UI reports accuracy, Spearman ρ and threshold.

---

## 5. The real UPMEM kernels

Four DPUs, 16 tasklets per DPU, `1 << 20` int32 elements per DPU (4 MiB per array).
Cycles are the maximum across tasklets from `perfcounter_get()`.

| Kernel | Source | What it does | Measured cycles | Check |
|---|---|---|---:|---|
| **VA** | `pim-kernels/va/` | Streams 256 B blocks of A and B, adds, writes C; no merge | 12,812,752 | 0 errors vs CPU |
| **GEMV** | `pim-kernels/gemv/` | Matrix rows stay in MRAM; `x` staged once into WRAM behind a barrier | 27,362,256 | 0 errors vs CPU |
| **RED** | `pim-kernels/red/` | Tasklet partials → barrier → one partial per DPU → host merge | 5,375,760 | sum −1,963,502 matches |
| **SEARCH** | `pim-kernels/search/` | Scan and count elements equal to 42; one count per DPU | 6,424,352 | 16,408 matches |
| **HIST** | `pim-kernels/hist/` | Private 256-bin histogram per tasklet, folded per DPU, merged on host | 10,640,480 | all 256 bins match |
| **GEMM** | `pim-kernels/gemm/` | 100×100 tiles, `d³ = 1,000,000` MACs per DPU | 27,933,632 | 0 errors vs CPU |

At 0.35 GHz these correspond to ≈36.6 ms, 78.2 ms, 15.4 ms, 18.4 ms, 30.4 ms and
79.8 ms respectively. All six **passed correctness checks**.

Measured host phases (VA, 4 DPUs): `copy_in` 33.5 MB in 4.37 ms ≈ **7.65 GB/s**;
`copy_out` 16 MB in 2.55 ms. The `launch` phase is dominated by instruction-by-
instruction simulation and is deliberately **not** used as a silicon estimate.

### 5.1 Calibration ledger

`pim-simulator/src/engine/calibration.ts` records each constant and its source; the
**PIM internals** page renders it and offers one-click **Apply measured values**.

| Constant | Measured / published | Source |
|---|---:|---|
| Host ↔ DPU copy BW | 7.65 GB/s | measured here |
| Integer multiply cost | 3.33× an add | back-solved from GEMV cycles |
| Per-DPU MRAM BW | 0.63 GB/s | PrIM 2022 |
| DPU clock | 0.35 GHz | SDK spec |
| DPU throughput | 0.166 ops/cycle | PrIM 2022 |
| Off-chip energy | 160 pJ/B | Horowitz 2014 |
| Kernel launch | 50 µs | model assumption |

### 5.2 Event stream format

```json
{"event":"meta","kernel":"VA","dpus":4,"tasklets":16,"n":4194304,"ops":4194304}
{"event":"phase","name":"copy_in","ms":4.374,"bytes":33554432}
{"event":"dpu","cycles":12812752,"dpus":4}
```

RED/SEARCH add a `merge` event with `bytes`; HIST's merge covers 256 bins. The
browser reducer turns these events into the same timeline whether they came live
over SSE or from a bundled `.jsonl` replay.

---

## 6. Scheduler and Algorithm Lab (the five upgrades)

### 6.1 Adaptive CPU ⇄ PIM scheduling

Default demo: **1,000,000 elements, 8 DPUs, 32 tasks, seed 42, resident data.**

| Policy | Makespan | Speedup | CPU/PIM tasks | PIM util. | Conflicts |
|---|---:|---:|---:|---:|---:|
| CPU sequential | 0.499 ms | 1.00× | 32 / 0 | — | 0 |
| Static PIM | 2.882 ms | 0.17× | 0 / 32 | 31.7% | 13 |
| FCFS | 0.302 ms | 1.65× | 4 / 28 | 83.6% | 14 |
| Round Robin | 0.370 ms | 1.35× | 4 / 28 | 68.2% | 15 |
| **Adaptive** | **0.231 ms** | **2.16×** | **13 / 19** | **85.1%** | **2** |

Adaptive is **23.4% faster than the best baseline**. Algorithm:

1. Sort tasks by `max(cpuS, pim1S)` descending (LPT).
2. For each task, consider CPU and 1/2/4/8 DPUs (capped by `preferredUnits`).
3. Compute predicted finish time on least-loaded lanes.
4. Choose the earliest finish; place on those lanes and explain the arithmetic.

Static PIM loses because it sends HIST/GEMM to the DPU and pays launch overhead
(50 µs amortised over ~25 tasks = 2 µs per task) without a cost model.

### 6.2 Load balancing

Adaptive picks lanes with `sort(free, laneTasks, laneIndex)` — earliest-free, then
fewer tasks, then lower index — so lanes stay busy. Round Robin just cycles and can
stall one lane behind a large task. The **Load** tab compares per-lane utilisation.

### 6.3 Memory manager (modelled)

UPMEM's host API exposes DPUs, not physical bank placement, so this is explicitly a
**logical** model:

- 16 bank parts of 64 KiB per DPU;
- resident data lives from `t = 0` to task end;
- a conflict is one pair of tasks sharing a bank over overlapping lifetimes.

On the adaptive schedule: First Fit and Best Fit produce **25 conflicts / 94 active
banks**; Bank-aware produces **2 conflicts / 109 active banks** (more spread, a bit
more internal fragmentation).

### 6.4 Algorithm Lab

- **Workloads:** run any subset of the six real kernels sequentially through the
  bridge; measured cycles vs modelled parallel packing. Different n, so compare
  shapes, not absolute times (the UI labels this).
- **Scaling:** model throughput vs DPU count, with the saved measured run as a
  diamond marker. RED/HIST flatten because merge grows with P.
- **Optimisation:** for VA the sweeps find **16 DPUs**, **32 chunks** (31,250
  elements/task), **5.11×** vs CPU, PIM crossover around **262K elements**.

### 6.5 Measured vs modelled — say this explicitly

| Quantity | Status |
|---|---|
| DPU cycles, host phases, correctness, traffic | **Measured** — real DPU ISA in SDK functional simulator |
| Scheduling, makespan, utilisation, speedup | **Modelled** — deterministic list scheduling |
| Bank conflicts / fragmentation | **Modelled** — logical allocator |
| Parallel composition, DPU/chunk/crossover sweeps, energy | **Modelled** |

---

## 7. How to run everything

### 7.1 Dashboard only (no SDK needed)

```bash
cd pim-simulator
npm install
npm run dev        # http://localhost:5173
```

Other commands:

```bash
npm test           # 31 tests (15 engine, 8 trace, 8 scheduler/memory)
npm run build      # tsc + Vite production build -> dist/
npm run preview    # serve the production build
```

### 7.2 Real kernels with the SDK directly

On this machine the environment script is
`/home/niraj/TY_College/ACA/upmem-env.sh` (template: `upmem-env.example.sh`).

```bash
cd pim-kernels
source ../../upmem-env.sh

make all NR_DPUS=4
for k in va gemv red search hist gemm; do
  PIM_EVENTS=1 ./build/${k}_host 2>build/${k}_events.jsonl
done
```

Or build and run one at a time:

```bash
make va NR_DPUS=4 && ./build/va_host
make search NR_DPUS=4 && ./build/search_host
make run_gemm NR_DPUS=4     # writes build/gemm_events.jsonl
```

`NR_DPUS` is baked into the binary, so the Makefile **always recompiles** when you
change it. Set `PIM_EVENTS=0` to silence the JSON channel.

### 7.3 Live bridge + dashboard (for the demo)

```bash
# terminal 1 — bridge
cd pim-simulator
node bridge/server.mjs              # http://localhost:8787

# terminal 2 — dashboard
cd pim-simulator
npm run dev                         # http://localhost:5173
```

Check the bridge:

```bash
curl http://localhost:8787/health
# {"ok":true,"kernelRoot":...,"env":...,"runs":6}
```

Bridge API:

```text
GET /health                                      liveness + config
GET /api/runs                                    list saved runs
GET /api/runs/:name                              fetch one stream
GET /api/run?kernel=VA|GEMV|RED|SEARCH|HIST|GEMM&dpus=4   SSE: build/run/stream/save
```

Environment overrides: `VITE_BRIDGE_URL` (default `http://localhost:8787`),
`PORT` (default `8787`), `UPMEM_ENV` (path to the SDK env script).

### 7.4 If the bridge is not running

The six `public/runs/*-4dpu.jsonl` files are bundled. On **Live DPU**, choose a
*Replay run* and press **Load** — no SDK or bridge needed. This is the safest demo
fallback.

---

## 8. Demo script for the professor

**Total: ~10–12 minutes.** Have `npm run dev` running; start the bridge too if the
SDK environment works. Open <http://localhost:5173>.

### Step 1 — The question (30 s)

> "Our question was: for a given workload and memory configuration, when does
> processing-in-memory beat a conventional CPU, by how much, and what limits it?
> We answered it twice: with an analytical model you can inspect formula by
> formula, and with six real kernels compiled to the UPMEM DPU instruction set."

### Step 2 — Simulator, default Vector Add (1 min)

Stay on **Simulator**, default preset (Simple mockup), default workload.

- Point at the **resident-data badge**: "0 B copy-in is an assumption — data is
  already in PIM banks, not a bug."
- Show the results: **≈2.5× speedup**, **≈90% energy saving**.
- Say: "The CPU bus floods while all PIM banks work in parallel. The PIM kernel
  is memory-bound but the data never crosses the host link."

### Step 3 — Cold data and break-even (1 min)

Click **Charge copy-in (cold data)**.

> "Now every PIM run pays for copying data in. PIM becomes slower. The break-even
> value tells us how many times the same data must be reused before the copy pays
> back — about 1.6 runs in the worked example. Toggle back to resident data."

### Step 4 — GEMM: the counterexample (1 min)

Change workload to **Matrix Multiply (tiled)**.

> "GEMM has high data reuse, so CPU caches already remove most memory traffic.
> PIM cores are weak at multiply, so the CPU wins. Open **Results → Roofline**:
> GEMM sits to the right of the ridge point — compute-bound."

### Step 5 — PIM internals and calibration (1.5 min)

Open **PIM internals**.

- Walk the DPU diagram: MRAM → 256 B DMA → 64 KiB WRAM → 16 tasklets.
- Open one formula row: symbolic formula → substituted numbers → explanation.
- Point at the critical path `max()` winner.
- Press **Apply measured values**: "This patches the live parameters with our
  measured 7.65 GB/s copy bandwidth and 3.33× multiply penalty."

### Step 6 — Live DPU: real kernel (1.5 min)

Open **Live DPU**.

- **If bridge is up:** choose `SEARCH` (or `VA`), 4 DPUs, press **Build & run on
  DPUs**. Show the cycle count and the correctness line from stdout. Explain:
  "The launch phase is mostly functional-simulator overhead; we use the DPU cycle
  counter, not wall time."
- **If bridge is down:** choose the bundled `SEARCH · 4 DPUs` demo and press
  **Load**. Same timeline, no hardware needed.
- Show the **Measured vs analytical model** table.

Expect SEARCH ≈ 6,424,352 cycles with 16,408 matches and 0 errors.

### Step 7 — Experiments: scaling limit (1 min)

Open **Experiments → E2 · PIM unit count**, pick **Reduction**.

> "Speedup flattens as units grow because every unit produces a partial that must
> be merged through the host. The merge term grows with P."

### Step 8 — Scheduler (2 min)

Open **Scheduler** (defaults: 1M elements, 8 DPUs, 32 tasks, seed 42).

- **Compare** tab: CPU 1.00×, Static PIM 0.17×, FCFS 1.65×, RR 1.35×,
  **Adaptive 2.16×** — "23.4% faster than the best baseline."
- **Tasks** tab: pick one CPU row and one PIM row; read the reason sentence —
  "the model prints the arithmetic: this path finishes X ms before the other."
- **Timeline** tab: show that PIM tasks get 1–4 DPUs, not always all 8.
- **Load** tab: show per-lane utilisation and idle gaps for Round Robin vs Adaptive.
- **Memory** tab: "First Fit 25 conflicts; Bank-aware 2 — a logical bank model,
  because UPMEM exposes DPUs rather than physical bank placement."

### Step 9 — Algorithm Lab (1.5 min)

Open **Algorithm Lab**.

- **Workloads**: six real kernels listed; replay or run them and show measured
  cycles. Point out the measured-vs-modelled labels.
- **Scaling**: model curve + measured diamond marker.
- **Optimisation**: "For VA the best design is 16 DPUs and 32 chunks; beyond that
  idle DPUs or dispatch overhead dominate. The PIM crossover is around 262K
  elements."

### Step 10 — Close (30 s)

> "All numbers in the simulator are decomposed into formulas; the kernel cycle
> counts are measured with on-chip counters in the SDK functional simulator.
> We validated with 31 tests and a hand-worked example. The main limitation is
> that this is a first-order model, not cycle-accurate silicon — but it captures
> the trade-offs: streaming wins, copying hurts, merge limits scaling, and
 > multiply-heavy work belongs on the CPU."

---

## 9. Viva cheat sheet (questions + answers)

| Question | Short answer |
|---|---|
| What is the memory wall? | CPU speed grew far faster than memory bandwidth; CPUs spend much time waiting for data. |
| What is PIM? | Moving computation next to/inside memory to avoid moving data to the CPU. |
| Near-memory vs using-memory PIM? | Near-memory adds logic beside banks (UPMEM); using-memory computes with DRAM cells (bulk bitwise ops). |
| Why does Vector Add suit PIM? | Streaming, no reuse, tiny compute — data is consumed where it lives, no partials to merge. |
| Why is GEMM bad for PIM? | High reuse means CPU caches already cut traffic; PIM cores are slow at multiply (software multiply). |
| Why does PIM lose with cold data? | Copy-in crosses the same narrow host link we were trying to avoid; need ~1.6 reuses to break even in the worked example. |
| Why does reduction stop scaling? | One partial per unit must be merged on the host; merge cost grows with P. |
| What is arithmetic intensity? | Operations per byte moved; low AI ⇒ bandwidth-bound, high AI ⇒ compute-bound. |
| What is a roofline? | Performance is min(peak compute, bandwidth × AI); the ridge separates memory-bound from compute-bound. |
| What does `0 B` copy-in mean? | Resident-data assumption; inputs are already in PIM banks. Toggle cold data to charge it. |
| What is a DPU tasklet? | One of 16 hardware threads sharing 64 KiB WRAM; explicit barriers and DMA. |
| Why WRAM and not caches? | UPMEM has no caches; staging into WRAM is explicitly controlled by the kernel. |
| What is a perfcounter? | On-chip cycle counter; we report the maximum across tasklets. |
| Is this real hardware? | No — SDK functional simulator. Instruction execution and cycle counts are real; wall time is simulation overhead. |
| How did you validate the simulator? | 31 unit tests, a hand-worked Phase 1 example, and comparison with published PrIM/Samsung trends. |
| What are the model's limitations? | First-order: no row-buffer conflicts, refresh, detailed cache/network, some energy values assumed. |
| How is the suitability score not a guess? | Factors come from the model; weights fitted by logistic regression and tested on ~500 configurations. |
| What does the adaptive scheduler do? | LPT order, CPU vs PIM by predicted finish, data-sized task width, least-loaded lanes. |
| Why is the bank allocator only a model? | UPMEM's API allocates DPUs, not physical banks; it reasons about conflicts, not real placement. |
| What did the five upgrades add? | Adaptive scheduling, load balancing, memory manager, real parallel workloads, optimisation sweeps. |

---

## 10. Limitations and troubleshooting

### 10.1 Limitations

- Analytical model is **first-order**: no row-buffer conflicts, refresh, memory
  controller scheduling, cache-line detail or network contention.
- In-bank latency 60 ns, host merge 2 Gops/s and 50 µs launch are **assumptions**,
  labelled in the calibration ledger.
- SDK functional simulator is instruction-accurate for the ISA but does not model
  silicon bank contention. No physical UPMEM board is attached.
- Scheduler/Lab are models on the same cost functions; "parallel kernel execution"
  is modelled because the SDK runtime runs one kernel at a time.
- The Lab's measured anchor (~4.2M elements) and modelled column (1M elements)
  use different sizes — the UI labels this; compare trends, not absolute times.

### 10.2 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `libxml2.so.2: no version information available` | Harmless SDK warning on newer distros; builds still succeed. |
| `dpu-pkg-config: command not found` | Source `../../upmem-env.sh` in the same shell. |
| Host link fails on `python3.14` | Adjust `LIBDPU_PY` in `pim-kernels/Makefile`. |
| `me()` undeclared | Include `<defs.h>` in DPU source. |
| DMA size/pointer error | Lengths must be multiples of 8 bytes; cast to `__mram_ptr`. |
| Live page says "No bridge at …" | Start `node bridge/server.mjs`, or replay a bundled demo. |
| Port in use | `PORT=8788 node bridge/server.mjs`; set `VITE_BRIDGE_URL` accordingly. |
| Wrong DPU count | Rebuild — the Makefile recompiles for the requested `NR_DPUS`. |

---

## 11. Work division among 4 team members

The project is deliberately split into **four independent but connected parts**. Each
member owns a set of files, a set of demo minutes and a set of likely viva questions.
This way every member can explain their own work in depth and the group can present
one continuous story.

### 12.1 The four roles at a glance

| Member | Role | Owns (main files) | Main contribution |
|---|---|---|---|
| **Member 1** | Theory & Analytical Model Lead | `pim-simulator/docs/model-spec.md`, `src/engine/{params,workloads,cpuModel,pimModel,energy,simulate,trace,calibration}.ts`, `tests/engine.test.ts`, `tests/trace.test.ts` | Equations, presets, worked example, calibration ledger, formula trace |
| **Member 2** | Dashboard & Visualization Lead | `src/App.tsx`, `src/pages/{Simulator,Experiments,Results,Learn,About}.tsx`, `src/components/*`, `src/styles/*` | UI shell, results table, charts, roofline, E1–E10 experiments, resident badge |
| **Member 3** | UPMEM Kernels & Measurement Lead | `pim-kernels/**`, `upmem-env.sh`, `pim-simulator/bridge/server.mjs`, `src/state/live.ts`, `src/pages/Live.tsx` | Six real DPU kernels, correctness checks, cycle counts, JSONL events, SSE bridge |
| **Member 4** | Scheduler, Lab & Integration Lead | `src/engine/{tasks,scheduler,memory,benchmark,optimize}.ts`, `src/pages/{Scheduler,Lab}.tsx`, `tests/scheduler.test.ts`, `README.md`, `PROJECT_GUIDE.md` | Five scheduling policies, memory manager, Algorithm Lab, optimisation sweeps, docs & git |

### 12.2 Member 1 — Theory & Analytical Model Lead

**Goal:** make sure every number the dashboard prints can be traced to an equation and
a source constant.

**Responsibilities**
- Study the memory wall, PIM taxonomy and roofline model.
- Write the first-order CPU and PIM equations in `docs/model-spec.md`.
- Presets: Simple mockup, UPMEM-like, HBM-PIM-like (`params.ts`).
- Workload descriptors for VA, VM, RED, SEL, GEMV, GEMM, HST, BFS (`workloads.ts`).
- Time and energy models (`cpuModel.ts`, `pimModel.ts`, `energy.ts`).
- Simulation orchestration and formula trace (`simulate.ts`, `trace.ts`).
- Calibration ledger with sources (`calibration.ts`) and the
  **Apply measured values** button.
- Unit tests for the model and trace (part of the 31 tests).

**What this member says in the demo**
- Step 1 (the question), Step 2 (formula-backed results), Step 3 (cold data /
  break-even), Step 5 (formula inspector + calibration ledger).
- Answers: memory wall, PIM definition, roofline, AI, speedup, break-even,
  why GEMM loses, why `0 B` is an assumption.

**Deliverables to show the professor**
- `docs/model-spec.md`, the worked example in `PIM_Project_Plan.md`, and the
  formula → substitution → explanation inspector on **PIM internals**.

### 12.3 Member 2 — Dashboard & Visualization Lead

**Goal:** turn the model into something a professor can interact with in 10 seconds.

**Responsibilities**
- App shell, navigation and routing across all nine pages (`App.tsx`).
- Simulator page: controls, datapath animation, results table, breakdowns, bank
  utilisation, suitability card, optimiser, resident-data badge and cold-data
  toggle (`pages/Simulator.tsx`).
- Charts, gauges, tables, roofline and architecture diagram (`components/*`).
- Experiments page with E1–E10 sweeps and CSV export (`pages/Experiments.tsx`).
- Results page: performance graphs, roofline, quick comparison (`pages/Results.tsx`).
- Learn and About pages (theory in the UI, scope, limitations, references).

**What this member says in the demo**
- Steps 2–4 (Simulator default, cold toggle, GEMM counterexample), Step 7
  (Experiments E2 scaling limit), and the Results roofline.
- Answers: how to read the dashboard, what each chart means, how the suitability
  score is computed, what the experiments prove.

**Deliverables to show the professor**
- A running dashboard at `http://localhost:5173`, the cold-data toggle changing
  the numbers live, and a CSV export from Experiments.

### 12.4 Member 3 — UPMEM Kernels & Measurement Lead

**Goal:** prove the model against real DPU instruction execution.

**Responsibilities**
- Shared headers and JSON event emitters (`pim-kernels/common/`).
- Six kernels in C: VA, GEMV, RED, SEARCH, HIST, GEMM. Each has a DPU program
  (`dpu.c`) and a host program (`host.c`).
- Correct staging: MRAM → 256 B DMA → WRAM → tasklets; barriers for reductions;
  host merge for partials.
- Correctness verification against CPU reference implementations.
- Perfcounter cycle measurement and phase timing; JSONL event streams.
- Makefile (`make all NR_DPUS=4`, `make run_*`).
- SDK environment script (`upmem-env.sh`, template `upmem-env.example.sh`).
- Bridge API (`bridge/server.mjs`) and Live DPU event reducer / replay
  (`src/state/live.ts`, `src/pages/Live.tsx`).

**What this member says in the demo**
- Step 6 (Live DPU: build & run or replay a real kernel), the measured-vs-model
  table, and the honesty note about the functional simulator.
- Answers: DPU vs tasklet, MRAM vs WRAM, why DMA, why barriers, what a
  perfcounter measures, why host wall time is not silicon time.

**Deliverables to show the professor**
- The six saved `runs/*-4dpu.jsonl` streams, the correctness lines (0 errors),
  and the measured cycle table (12.8M / 27.4M / 5.4M / 6.4M / 10.6M / 27.9M).

### 12.5 Member 4 — Scheduler, Lab & Integration Lead

**Goal:** connect the model and the kernels into intelligent placement and
optimisation, and keep the whole project shippable.

**Responsibilities**
- Deterministic task generator with CPU/PIM cost functions (`tasks.ts`).
- Five scheduling policies: CPU sequential, Static PIM, FCFS, Round Robin,
  Adaptive (`scheduler.ts`), with per-task decision reasons and Gantt lanes.
- Logical bank allocator and conflict accounting (`memory.ts`).
- Policy comparison aggregation (`benchmark.ts`).
- DPU-count, chunk-size and crossover sweeps (`optimize.ts`).
- Scheduler UI (Tasks / Timeline / Load / Memory / Compare) and Algorithm Lab
  UI (Workloads / Scaling / Optimisation).
- Scheduler regression tests (`tests/scheduler.test.ts`).
- README and this guide, commits, pushes and final integration checks.

**What this member says in the demo**
- Step 8 (Scheduler: 2.16× adaptive, 23.4% over best baseline) and Step 9
  (Algorithm Lab: six workloads, scaling, optimisation).
- Answers: what adaptive scheduling does, why load balancing matters, why the
  bank allocator is a logical model, which results are measured vs modelled.

**Deliverables to show the professor**
- The Scheduler Compare table, the bank-conflict comparison (25 → 2), the
  optimisation result (16 DPUs, 32 chunks, 5.11×), and a clean `git status`.

### 12.6 Who presents which demo minute

| Demo step (from §8) | Presenter |
|---|---|
| 1. The research question | Member 1 |
| 2. Simulator default / resident badge | Member 1 + Member 2 |
| 3. Cold data and break-even | Member 1 |
| 4. GEMM counterexample / roofline | Member 1 + Member 2 |
| 5. PIM internals + calibration | Member 1 |
| 6. Live DPU real kernel | Member 3 |
| 7. Experiments E2 scaling | Member 2 |
| 8. Scheduler | Member 4 |
| 9. Algorithm Lab | Member 4 |
| 10. Closing summary | Member 4 (with all four adding one sentence) |

### 12.7 Suggested build order (who depends on whom)

```text
Week 1  Member 1: theory + equations + worked example
        Member 2: learn the UI stack, scaffold pages
        Member 3: install SDK, compile the first VA kernel
        Member 4: read the plan, design the task model

Week 2  Member 1: engine + tests
        Member 2: Simulator UI on top of the engine
        Member 3: VA / GEMV / RED + correctness + JSONL
        Member 4: scheduler + memory model + tests

Week 3  Member 1: calibration ledger from Member 3's numbers
        Member 2: charts, roofline, experiments, results
        Member 3: SEARCH / HIST / GEMM + bridge + Live page
        Member 4: Scheduler and Lab pages + docs

Week 4  All: integrate, run `npm test && npm run build`, rehearse the §8 demo
        Member 4: final git commit / push
```

### 12.8 Per-member checklist before the demo

- [ ] **Member 1** — can derive `T_CPU`, `T_PIM` and break-even on a whiteboard.
- [ ] **Member 2** — dashboard loads; cold-data toggle visibly changes speedup.
- [ ] **Member 3** — can run `make all NR_DPUS=4` and explain a `meta`/`dpu` event.
- [ ] **Member 4** — knows all five policy names and the measured-vs-modelled table.
- [ ] **All** — can state clearly: *"functional simulator, no physical board."*

---

## 12. References

1. J. Gómez-Luna et al., *Benchmarking a New Paradigm…*, IEEE Access 2022 (PrIM).
2. O. Mutlu et al., *A Modern Primer on Processing in Memory*, arXiv:2012.03112.
3. B. Hyun et al., *Pathfinding Future PIM Architectures…* (uPIMulator), HPCA 2024.
4. S. Lee et al., *Hardware Architecture and Software Stack for PIM Based on
   Commercial DRAM Technology* (HBM-PIM), ISCA 2021.
5. S. Williams et al., *Roofline: An Insightful Visual Performance Model*, CACM 2009.
6. M. Horowitz, *Computing's Energy Problem*, ISSCC 2014.
7. UPMEM SDK documentation, 2025.1.
8. J. Hennessy & D. Patterson, *Computer Architecture: A Quantitative Approach*, 6th ed.

---

*Quick links: [README.md](README.md) · [PIM_Project_Plan.md](PIM_Project_Plan.md) ·
[pim-simulator/docs/model-spec.md](pim-simulator/docs/model-spec.md) ·
[pim-kernels/README.md](pim-kernels/README.md)*
