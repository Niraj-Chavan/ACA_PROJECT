# Model Specification (Phase 1 deliverable)

First-order analytical model. All times in seconds, energies in joules,
bytes = 8 192-byte units? No — bytes are plain decimal quantities.
Notation: `n` elements, `P` PIM units (= banks × units/bank), `B_r`/`B_w`
bytes read/written per element, `W` ops per element, `R` random accesses
per element.

## CPU

```text
T_stream   = n·(B_r + B_w) / BW_mem
T_random   = n·R·latency / (cores × MLP)
T_compute  = n·W / (cores × f_cpu × ops_per_cycle)
T_CPU      = max(T_stream + T_random, T_compute)     # overlap, not addition
```

## PIM

```text
T_in       = resident ? 0 : input_bytes / BW_copy
work       = (n/P) × imbalance
T_bank     = work·(B_r + B_w) / BW_bank + work·R·60 ns
T_pcomp    = work·W·c / (f_pim × ops_per_cycle_pim)   c = 1 − mul_frac + mul_frac·mul_cost
T_kernel   = max(T_bank, T_pcomp)
T_merge    = P·partial_bytes / BW_copy + merge_ops / 2 Gops/s (host merge rate, assumption)
T_out      = result_on_host ? output_bytes / BW_copy : 0
T_PIM      = T_in + T_launch + T_kernel + T_merge + T_out + syncs·T_sync
```

## Metrics

```text
Speedup         = T_CPU / T_PIM
E_CPU           = n·(B_r+B_w)·e_offchip + n·W·e_cpu_op + P_cpu_static·T_CPU
E_PIM           = offchip_copy_bytes·e_offchip + n·(B_r+B_w)·e_inbank
                + n·W·c·e_pim_op + (P·P_unit + P_cpu_idle)·T_PIM
Energy saving   = (E_CPU − E_PIM)/E_CPU × 100 %
Break-even runs = (T_in + T_out)/(T_CPU − T_kernel)   (only if T_CPU > T_kernel)
Bank busy       CPU: (bytes_b / BW_bank)/T_CPU    PIM: T_kernel_unit / T_PIM
```

## Worked example (must match the engine — it does, to <1 %)

Vector Add, mockup defaults, n = 134 217 728 int32:

| Quantity | Value |
|---|---|
| CPU bytes | 1.61 GB |
| T_CPU | 64.4 ms (memory-bound) |
| PIM kernel (8 units) | 25.2 ms, launch 0.05 ms |
| T_PIM resident | ≈ 25.3 ms → **speedup 2.56×** |
| Copy-in + copy-out | 42.9 + 21.5 ms |
| T_PIM copied (+copy-out) | ≈ 89.6 ms → **speedup 0.72×** |
| Break-even runs | ≈ 1.6 → PIM wins from run 2 |
| E_CPU movement | 0.26 J · E_PIM in-bank 0.04 J |

The engine reproduces every row of this table (`tests/engine.test.ts`, 15/15).

## Assumptions and limitations

- In-bank random access ≈ 60 ns (assumption, editable conceptually via sliders).
- Host merges partials at ~2 Gops/s (assumption).
- No row-buffer conflicts, refresh, memory-controller scheduling or detailed
  cache hierarchy; energy values partly assumed (Horowitz ranges used where
  published). Trends, not cycle timings.
