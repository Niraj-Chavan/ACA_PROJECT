/*
 * red/dpu.c — Reduction (sum), DPU side.
 *
 * This kernel touches the two costs the analytical model adds on top of a
 * vectorized streaming kernel (Appendix A):
 *  - sync: a barrier across all tasklets before the intra-DPU combine
 *  - merge: the HOST sums one 4-byte partial per DPU (T_merge term)
 *
 * Tasklets sum their slices in WRAM, hit a hardware barrier, then tasklet 0
 * combines the 16 partials and reports one partial per DPU to the host.
 */
#include <barrier.h>
#include <defs.h>
#include <mram.h>
#include <perfcounter.h>
#include <stdint.h>
#include <stdio.h>

#include "common.h"

#define BLOCK_ELEMS (BLOCK_SIZE / 4)

BARRIER_INIT(red_barrier, NR_TASKLETS);

__dma_aligned int32_t CACHE[NR_TASKLETS][BLOCK_ELEMS];

__mram_noinit int32_t D_INPUT[N_ELEMENTS];

__host dpu_results_t DPU_RESULTS;

int main()
{
    uint32_t tasklet_id = me();
    dpu_result_t *result = &DPU_RESULTS.tasklet_result[tasklet_id];

    if (tasklet_id == 0)
        perfcounter_config(COUNT_CYCLES, true);

    int32_t partial = 0;
    for (uint32_t elem = tasklet_id * BLOCK_ELEMS; elem < N_ELEMENTS;
         elem += NR_TASKLETS * BLOCK_ELEMS) {
        mram_read(&D_INPUT[elem], CACHE[tasklet_id], BLOCK_SIZE);
        for (uint32_t i = 0; i < BLOCK_ELEMS; i++)
            partial += CACHE[tasklet_id][i];
    }

    /* hand partial to WRAM-visible results table, then hit the barrier */
    result->sum = partial;

    barrier_wait(&red_barrier);

    /* one designated tasklet combines the tasklet partials */
    if (tasklet_id == 0) {
        int32_t total = 0;
        for (uint32_t t = 0; t < NR_TASKLETS; t++)
            total += DPU_RESULTS.tasklet_result[t].sum;
        DPU_RESULTS.tasklet_result[0].sum = total;
        DPU_RESULTS.tasklet_result[0].cycles = (uint32_t)perfcounter_get();
    }
    return 0;
}
