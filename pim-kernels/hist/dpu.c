/*
 * hist/dpu.c — 256-bin histogram, DPU side.
 *
 * Every tasklet keeps a private 256-bin histogram in WRAM (1 KiB each), so the
 * increment path never crosses the DMA boundary. After a barrier tasklet 0
 * folds the tasklet histograms into one 256-bin partial for this DPU. The host
 * merges one partial per DPU — the communication term that limits scaling.
 */
#include <barrier.h>
#include <defs.h>
#include <mram.h>
#include <perfcounter.h>
#include <stdint.h>
#include <stdio.h>

#include "common.h"

#define BLOCK_ELEMS (BLOCK_SIZE / 4)

BARRIER_INIT(hist_barrier, NR_TASKLETS);

__dma_aligned int32_t CACHE[NR_TASKLETS][BLOCK_ELEMS];
__dma_aligned uint32_t LOCAL_HIST[NR_TASKLETS][HIST_BINS];

__mram_noinit int32_t H_INPUT[N_ELEMENTS];

__host hist_result_t DPU_HIST;

int main()
{
    uint32_t tasklet_id = me();
    uint32_t *mine = LOCAL_HIST[tasklet_id];

    if (tasklet_id == 0)
        perfcounter_config(COUNT_CYCLES, true);

    for (uint32_t bin = 0; bin < HIST_BINS; bin++)
        mine[bin] = 0;

    for (uint32_t elem = tasklet_id * BLOCK_ELEMS; elem < N_ELEMENTS;
         elem += NR_TASKLETS * BLOCK_ELEMS) {
        mram_read(&H_INPUT[elem], CACHE[tasklet_id], BLOCK_SIZE);
        for (uint32_t i = 0; i < BLOCK_ELEMS; i++)
            mine[CACHE[tasklet_id][i] & (HIST_BINS - 1)]++;
    }

    barrier_wait(&hist_barrier);

    if (tasklet_id == 0) {
        for (uint32_t bin = 0; bin < HIST_BINS; bin++) {
            uint32_t total = 0;
            for (uint32_t t = 0; t < NR_TASKLETS; t++)
                total += LOCAL_HIST[t][bin];
            DPU_HIST.bins[bin] = total;
        }
        DPU_HIST.pad = 0;
        DPU_HIST.cycles = (uint32_t)perfcounter_get();
    }
    return 0;
}
