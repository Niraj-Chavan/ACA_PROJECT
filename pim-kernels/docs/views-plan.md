# Dashboard plan: "PIM internals + formula inspector"

Goal: two new views in the pim-simulator app that answer sir's inevitable
questions — *"what exactly is this PIM hardware?"* and *"where does each number
in your model come from?"* — using live data where available.

## View 1 — PIM internals (anatomy page)

An interactive diagram of one DPU (from `ArchitectureViz` styling), driven by
the currently selected preset. Every annotated value is from `params.ts`, and
measured values (see kernel calibration) carry a "measured" badge vs "assumed".

```text
┌──────────────────────────── one DPU ──────────────────────────────┐
│  IRAM  24 KiB  program          (fixed, real value)                │
│  WRAM   8 MiB  tasklet scratch  × 24 tasklets                      │
│  MRAM  64 MiB  private DRAM bank ←── mram_read/write DMA (8 B gran)│
│  core: 32-bit, 14-stage, ~350 MHz, no mul, no cache, no predictor  │
│  multiplicand cost: assumed 5.7 → measured [(from DPU microbench)] │
│  inter-DPU link: NONE — host-mediated only (the T_merge term)      │
└───────────────────────────────────────────────────────────────────┘
   ↑ host bus traffic shown live: bytes in / bytes out (from events.jsonl)
```

Panels:
- **Anatomy diagram** with hover tooltips explaining each region
- **"Why no multiply?"** callout connecting to GEMV/compute-bound findings
- **Live bus traffic** while a run replays: animated counters of
  copy-in/copy-out bytes (real values from the event stream)
- **Tasklet view**: 24 lanes showing the rake partition pattern of va.c

## View 2 — Formula inspector (the algorithm, computed live)

A step-by-step derivation panel that recomputes with every slider change.
Each line shows: formula → substituted values → result, in execution order.

```text
T_CPU
  T_stream   = n·(B_r+B_w) ÷ BW      = 134.2M × 12 B ÷ 25 GB/s  = 64.4 ms
  T_compute  = n·W ÷ (cores·f·opc)   = 134.2M ÷ (8×3.5G×4)      =  1.2 ms
  T_CPU      = max(stream, compute)                              = 64.4 ms

T_PIM
  T_in       = input ÷ copy_BW       = 1.07 GB ÷ 25 GB/s        = 42.9 ms
  T_bank     = work·B ÷ bankBW       = 201 MB ÷ 8 GB/s          = 25.2 ms
  T_pcomp    = work·W·c ÷ (f_p·opc)  = 16.8M × 1 ÷ 1 GOPS       = 16.8 ms
  T_kernel   = max(T_bank, T_pcomp)                              = 25.2 ms
  T_merge    = P·partial ÷ copyBW + …                            = 0.7 ms
  T_out      = output ÷ copy_BW                                  = 21.5 ms
             ─────────────────────────────────────────────
  T_PIM      = T_in+launch+T_kernel+T_merge+T_out                = 90.3 ms
  speedup    = 64.4 ÷ 25.3 (resident) = 2.56×
             | 64.4 ÷ 89.6 (copied)  = 0.72×
```

Rules:
- every intermediate value already exists in `src/engine/*` — this view only
  needs a `getFormulaTrace(params, workload, n)` in the engine that returns
  `{ label, formula, substitution, value, unit, highlight }` steps
- the step powering each model pitch (break-even, suitability factors) gets a
  one-line "why this matters" tooltip reusing the plan's Appendix I answers
- **Calibration mode** (the crown): toggle shows each constant as
  `assumed X → measured Y (source: DPU microbench / PrIM table)` and the delta
  it caused in the final result — the validation table, made interactive

## Data flow (shared with live runs)

`pim-kernels` events.jsonl → Node bridge (WS) → `liveStore` →
{ timeline bars, per-DPU cycles, measured-vs-predicted panel, traffic counters }.
Replay mode: load saved `runs/*.jsonl` with the same store; no live SDK needed
on demo day.

## Build order

1. Formula inspector (pure engine work — no new infra)          ~2 d
2. Internals view, static with preset values                    ~2 d
3. Node bridge + live/replay store + measured-vs-predicted      ~2 d
4. Calibration toggle (needs ≥1 calibrated parameter measured)  ~1 d
```
