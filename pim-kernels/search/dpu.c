/*
 * search/dpu.c — Parallel array search (count matches), DPU side.
 *
 * Each tasklet scans its rake of 256-byte blocks and counts elements equal to
 * SEARCH_TARGET. Tasklet partials are combined in WRAM after a barrier, so the
 * host receives one count per DPU instead of one per tasklet.
 */
#include <barrier.h>
#include <defs.h>
#include <mram.h>
#include <perfcounter.h>
#include <stdint.h>
#include <stdio.h>

#include "common.h"

#define BLOCK_ELEMS (BLOCK_SIZE / 4)
#define SEARCH_TARGET 42

BARRIER_INIT(search_barrier, NR_TASKLETS);

__dma_aligned int32_t CACHE[NR_TASKLETS][BLOCK_ELEMS];

__mram_noinit int32_t S_INPUT[N_ELEMENTS];

__host dpu_results_t DPU_RESULTS;

int main()
{
    uint32_t tasklet_id = me();
    dpu_result_t *result = &DPU_RESULTS.tasklet_result[tasklet_id];

    if (tasklet_id == 0)
        perfcounter_config(COUNT_CYCLES, true);

    int32_t matches = 0;
    for (uint32_t elem = tasklet_id * BLOCK_ELEMS; elem < N_ELEMENTS;
         elem += NR_TASKLETS * BLOCK_ELEMS) {
        mram_read(&S_INPUT[elem], CACHE[tasklet_id], BLOCK_SIZE);
        for (uint32_t i = 0; i < BLOCK_ELEMS; i++)
            matches += (CACHE[tasklet_id][i] == SEARCH_TARGET);
    }

    result->sum = matches;

    barrier_wait(&search_barrier);

    if (tasklet_id == 0) {
        int32_t total = 0;
        for (uint32_t t = 0; t < NR_TASKLETS; t++)
            total += DPU_RESULTS.tasklet_result[t].sum;
        DPU_RESULTS.tasklet_result[0].sum = total;
        DPU_RESULTS.tasklet_result[0].cycles = (uint32_t)perfcounter_get();
    }
    return 0;
}
