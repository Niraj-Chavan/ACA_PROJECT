/*
 * gemm/dpu.c — Tiled matrix multiply C = A·B, DPU side.
 *
 * This is the CPU counterexample: each A row is reused across every column of
 * C, so the work is multiply-heavy rather than memory-bound. UPMEM has no
 * hardware multiplier, so the ISA runs multiplications in software.
 *
 * GEMM_N = 100 gives d^3 = 1,000,000 multiply-accumulates per DPU, matching
 * the model's n for the 1M-element experiment.
 *
 * WRAM budget (64 KiB):
 *   A_CACHE  16 × 100 × 4 = 6,400 B
 *   B_CACHE  16 × 100 × 4 = 6,400 B
 *   C_ACC    16 × 100 × 4 = 6,400 B
 */
#include <barrier.h>
#include <defs.h>
#include <mram.h>
#include <perfcounter.h>
#include <stdint.h>
#include <stdio.h>

#include "common.h"

#define GEMM_N 100

BARRIER_INIT(gemm_barrier, NR_TASKLETS);

__dma_aligned int32_t A_CACHE[NR_TASKLETS][GEMM_N];
__dma_aligned int32_t B_CACHE[NR_TASKLETS][GEMM_N];
__dma_aligned int32_t C_ACC[NR_TASKLETS][GEMM_N];

__mram_noinit int32_t A_MRAM[GEMM_N][GEMM_N];
__mram_noinit int32_t B_MRAM[GEMM_N][GEMM_N];
__mram_noinit int32_t C_MRAM[GEMM_N][GEMM_N];

__host dpu_results_t DPU_RESULTS;

int main()
{
    uint32_t tasklet_id = me();
    dpu_result_t *result = &DPU_RESULTS.tasklet_result[tasklet_id];

    if (tasklet_id == 0)
        perfcounter_config(COUNT_CYCLES, true);

    uint32_t rows_done = 0;
    for (uint32_t r = tasklet_id; r < GEMM_N; r += NR_TASKLETS) {
        mram_read(&A_MRAM[r][0], A_CACHE[tasklet_id], GEMM_N * 4);
        for (uint32_t j = 0; j < GEMM_N; j++)
            C_ACC[tasklet_id][j] = 0;

        for (uint32_t k = 0; k < GEMM_N; k++) {
            mram_read(&B_MRAM[k][0], B_CACHE[tasklet_id], GEMM_N * 4);
            const int32_t a = A_CACHE[tasklet_id][k];
            for (uint32_t j = 0; j < GEMM_N; j++)
                C_ACC[tasklet_id][j] += a * B_CACHE[tasklet_id][j];
        }

        mram_write(C_ACC[tasklet_id], &C_MRAM[r][0], GEMM_N * 4);
        rows_done++;
    }

    barrier_wait(&gemm_barrier);
    result->cycles = (uint32_t)perfcounter_get();
    result->sum = (int32_t)rows_done;
    return 0;
}
