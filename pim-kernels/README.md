# UPMEM PIM kernels — the real DPU ISA, not a drawing

Three kernels written against the **UPMEM SDK 2025.1** programming model and
compiled by `dpu-upmem-dpurte-clang` to the **actual DPU instruction set**. They
are launched by the SDK host runtime, executed in the DPU functional simulator
(`simulator` mode), and checked element-by-element against a CPU reference.

The point of this directory is that the dashboard's analytical model is not the
only thing that runs. The same workloads also execute as real DPU programs, and
their on-chip `perfcounter` cycles and host-measured transfer times feed the
calibration ledger in the UI.

> No UPMEM hardware is attached to this machine. The SDK functional simulator
> executes the compiled DPU binary instruction-by-instruction. Absolute host
> wall time is simulation overhead; **DPU cycle counts** and the shape of each
> phase are what we use.

## Prerequisites

- UPMEM SDK 2025.1 extracted at `~/TY_College/ACA/upmem-sdk/...` (path is in
  `../upmem-env.sh`). The official SDK targets Ubuntu 20.04; this machine runs a
  newer distro, so `~/.local/lib/upmem-fix` holds the compatibility libraries.
- Source the environment **in every shell** before building or running:

```bash
source ~/TY_College/ACA/upmem-env.sh
```

This selects `simulator` mode and appends the compatibility library path. The
SDK's clang prints a harmless `libxml2.so.2` version warning on this distro.

## Layout

```
common/common.h      N_ELEMENTS, BLOCK_SIZE, NR_TASKLETS, result structs
common/host_util.h   monotonic timers + JSON event emitters (stderr)
va/                  vector add   C = A + B          (pure streaming)
gemv/                matrix–vector y = A·x            (multiply-bound)
red/                 reduction    sum(D)              (barrier + host merge)
Makefile             make va | gemv | red | all | run_*
runs/                saved event streams for dashboard replay
```

## Build and run

```bash
source ~/TY_College/ACA/upmem-env.sh
cd ~/TY_College/ACA/ACA_PROJECT/pim-kernels

make va   NR_DPUS=4 && ./build/va_host
make gemv NR_DPUS=4 && ./build/gemv_host
make red  NR_DPUS=4 && ./build/red_host

# same thing, writing the replayable event stream:
make run_va NR_DPUS=4      # build/va_events.jsonl
make run_gemv NR_DPUS=4
make run_red NR_DPUS=4

make clean
```

`NR_DPUS` defaults to **16**; `NR_TASKLETS` defaults to **16**. Each VA/RED DPU
owns `N_ELEMENTS = 1 << 20` int32 elements (4 MiB per array per DPU). GEMV fixes
the problem at 1024×1024 per DPU so the vector fits in shared WRAM.

### What was measured (4 DPUs, 16 tasklets)

| Kernel | Logical n | Input traffic | DPU cycles (max tasklet) | Result |
|---|---:|---:|---:|---|
| VA | 4,194,304 | 32 MiB | 12,812,752 | 0 errors vs CPU |
| GEMV | 4,194,304 | 16 MiB + x broadcast | 27,362,256 | 0 errors vs CPU |
| RED | 4,194,304 | 16 MiB | 5,375,760 | sum = −1,963,502, 0 errors |

Copy-in bandwidth on this machine measured **7.65 GB/s** for VA, **2.2 ms** for
the 16 MiB RED transfer. The dashboard's calibration ledger back-solves the
integer-multiply penalty from GEMV (`c_mul ≈ 3.33× an add`).

## What each kernel exercises

**VA — vector add.** Every tasklet walks its slice in 256-byte DMA blocks:
`mram_read` A and B into WRAM, add, `mram_write` C back. No partials, no merge.
This is the streaming best case: the measured time is dominated by transfer, not
arithmetic.

**GEMV — matrix–vector multiply.** Rows live in MRAM and are streamed one block
at a time. The whole `x` vector (4 KiB) is staged once into a shared WRAM buffer
behind a `BARRIER_INIT` / `barrier_wait`, so all sixteen tasklets read it from WRAM
rather than re-reading MRAM. Each tasklet owns whole rows, so there is no merge.
The kernel is **multiply-bound**: the DPU ISA implements 32-bit multiply as a
software sequence, which is exactly the `c_mul` correction in the model.

**RED — reduction.** Each tasklet sums its slice into WRAM, stores a partial,
then hits a hardware barrier. Tasklet 0 combines the 16 partials into one
per-DPU value. The host then sums one 4-byte partial per DPU — the model's
`T_merge` term, visible as a separate `merge` phase in the event stream.

## Event stream (dashboard input)

With `PIM_EVENTS=1` (the default unless set to `0`), each host prints one JSON
object per line on **stderr**; all other output stays on stdout:

```json
{"event":"meta","kernel":"VA","dpus":4,"tasklets":16,"n":4194304,"ops":4194304}
{"event":"phase","name":"alloc_load","ms":0.61,"bytes":0}
{"event":"phase","name":"copy_in","ms":3.734,"bytes":33554432}
{"event":"phase","name":"launch","ms":423.246,"bytes":0}
{"event":"phase","name":"copy_out","ms":2.548,"bytes":16777216}
{"event":"dpu","cycles":12812752,"dpus":4}
```

`meta.n` is defined so it maps 1:1 onto the analytical model's n for the same
workload, which lets the dashboard compare measured and predicted kernel time at
the same configuration. RED additionally emits `{"event":"phase","name":"merge",...}`.

`runs/` holds the three demo streams (VA, GEMV, RED at 4 DPUs). The dashboard
copies of these live in `../pim-simulator/public/runs/` so replay works with the
bridge offline.

## Portability notes (things that cost time)

- `_POSIX_C_SOURCE=200112L` must be a **compiler flag** (`HOST_CFLAGS`), not a
  header `#define` — the host uses `clock_gettime`.
- Host links `-lpython3.14` because the SDK's `libdpu.so` depends on the Python
  shared library; adjust `LIBDPU_PY` in the Makefile if your interpreter differs.
- `mram_read` / `mram_write` lengths must be multiples of 8 bytes and take
  `__mram_ptr` cast addresses. `me()` needs `<defs.h>`.
- DPU WRAM is only 64 KiB. GEMV shares one 4 KiB `X_WRAM` among all tasklets
  instead of giving each tasklet its own copy.
- Per-DPU transfers must be `dpu_prepare_xfer` + `dpu_push_xfer`; a plain
  `dpu_broadcast_to` cannot address a different host buffer per DPU.
