/*
 * gemv/dpu.c — Matrix–Vector multiply y = A·x, DPU side (the headline PIM kernel).
 *
 * Per DPU: a contiguous slice of ROWS_PER_DPU rows (d = GEMV_D columns each),
 * plus the FULL vector x — "x copied to every unit" (Appendix C). Each row is
 * read from MRAM exactly once and never reused: arithmetic intensity ≈ 0.5
 * ops/byte, so the machine is data-bound in theory and multiply-bound in
 * practice on UPMEM (the only op in the ISA that isn't single-cycle).
 *
 * WRAM is only 64 KiB total, so x lives in ONE shared 4 KiB buffer loaded
 * cooperatively by all tasklets, guarded by a hardware barrier.
 *
 * Runs on the real UPMEM DPU ISA: no caches, explicit MRAM→WRAM DMA.
 */
#include <barrier.h>
#include <defs.h>
#include <mram.h>
#include <perfcounter.h>
#include <stdint.h>
#include <stdio.h>

#include "common.h"

#define GEMV_D 1024             /* columns; x is GEMV_D int32 */
#define ROWS_PER_DPU 1024       /* matrix rows held by this DPU */
#define ROW_BLOCK (BLOCK_SIZE / 4) /* 64 ints per row DMA chunk */

BARRIER_INIT(gemv_barrier, NR_TASKLETS);

__dma_aligned int32_t A_CACHE[NR_TASKLETS][ROW_BLOCK];
__dma_aligned int32_t X_WRAM[GEMV_D]; /* shared, read-only after the barrier */
__dma_aligned int32_t Y_CACHE[NR_TASKLETS][ROWS_PER_DPU / NR_TASKLETS];

__mram_noinit int32_t A_MRAM[ROWS_PER_DPU][GEMV_D];
__mram_noinit int32_t X_MRAM[GEMV_D];
__mram_noinit int32_t Y_MRAM[ROWS_PER_DPU];

__host dpu_results_t DPU_RESULTS;

int main()
{
    uint32_t tasklet_id = me();
    dpu_result_t *result = &DPU_RESULTS.tasklet_result[tasklet_id];

    const uint32_t rows_this = ROWS_PER_DPU / NR_TASKLETS;   /* 64 */
    const uint32_t my_first = tasklet_id * rows_this;        /* contiguous slice */

    if (tasklet_id == 0)
        perfcounter_config(COUNT_CYCLES, true);

    /* cooperatively load the whole vector into shared WRAM (one block each) */
    for (uint32_t off = tasklet_id * BLOCK_SIZE; off < GEMV_D * 4;
         off += NR_TASKLETS * BLOCK_SIZE)
        mram_read((__mram_ptr const void *)((const char *)X_MRAM + off),
            (void *)((char *)X_WRAM + off), BLOCK_SIZE);
    barrier_wait(&gemv_barrier);

    int32_t *y = Y_CACHE[tasklet_id];

    for (uint32_t rr = 0; rr < rows_this; rr++) {
        const uint32_t r = my_first + rr;
        int32_t acc = 0;
        for (uint32_t off = 0; off < GEMV_D; off += ROW_BLOCK) {
            mram_read(&A_MRAM[r][off], A_CACHE[tasklet_id], BLOCK_SIZE);
            const int32_t *a = A_CACHE[tasklet_id];
            for (uint32_t k = 0; k < ROW_BLOCK; k++)
                acc += a[k] * X_WRAM[off + k]; /* mul + add per element */
        }
        y[rr] = acc;
    }

    /* one contiguous 256-byte write for this tasklet's y slice */
    mram_write(y, &Y_MRAM[my_first], rows_this * 4);

    result->cycles = (uint32_t)perfcounter_get();
    result->sum = 0;
    return 0;
}
