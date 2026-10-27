# Phase 0 learning notes — one page per topic

## Memory wall
Compute throughput grew ~2× every 2 years while DRAM bandwidth grew ~2×
every 10 years. Once the working set exceeds the last-level cache the CPU
waits on the bus. Why the CPU waits: ~100 ns DRAM latency vs ~1 ns L1, and
bandwidth shared across all cores.

## Latency vs bandwidth vs throughput
Latency = time for one request (ns). Bandwidth = bytes per second.
Throughput = operations per second (depends on both plus compute). MLP hides
latency by overlapping misses but not bandwidth.

## DRAM organisation
Channel → rank → chip → bank → row. Row buffer is the bank-level working
unit; a bank serves one row at a time. Banks are the natural PIM site
(UPMEM: one DPU per bank, 2,560 total).

## Arithmetic intensity & roofline
AI = ops / bytes moved. Ridge point = peak compute ÷ bandwidth. Below ridge:
memory-bound (VA ≈ 0.17–0.5 ops/B). Above ridge: compute-bound (tiled GEMM
grows AI with matrix size) — hence GEMM is the CPU counterexample.

## PIM types
- Processing-near-memory: logic beside banks (UPMEM DPUs, Samsung HBM-PIM,
  SK hynix GDDR6-AiM, Samsung LPDDR5X-PIM).
- Processing-using-memory: compute with DRAM cells (RowClone bulk copy,
  Ambit bitwise via sense amps).

## Key findings (PrIM, ETH)
PIM wins on memory-bound kernels (VA, SEL, GEMV); UPMEM DPUs are
compute-bound internally (~350 MHz, multiply in software ×5.7 cost); no
inter-DPU communication — reductions and histograms merge through the host,
which caps scaling. Copy-in across the host bus can erase the entire gain.

## Copy-in cost idea
T_copy-in = input_bytes / copy_BW crosses the same bus PIM avoids. Data
reused across runs amortises the copy: break-even runs =
(T_in + T_out)/(T_CPU − T_kernel) ≈ 1.6 for VA mockup — payback from run 2.
