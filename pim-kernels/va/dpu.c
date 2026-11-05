/*
 * dpu/va.c — Vector Add kernel, DPU side.
 *
 * This code runs INSIDE a simulated (or real) UPMEM DRAM Processing Unit:
 *  - A and B live in the DPU's private 64 MiB MRAM bank
 *  - tasklets (hardware threads, up to 24) each grab 256-byte blocks
 *    following the "rake" pattern: tasklet T handles block T, T+N, T+2N...
 *  - blocks are DMA'd into the tasklet's private WRAM slice, added,
 *    and written back — no caches exist on this architecture
 *
 * Each tasklet records its cycle count via the DPU performance counters,
 * reported back to the host through the DPU_RESULTS transfer area.
 */
#include <defs.h>
#include <mram.h>
#include <perfcounter.h>
#include <stdint.h>
#include <stdio.h>

#include "common.h"

#define BLOCK_ELEMS (BLOCK_SIZE / 4) /* 64 int32 per block */

__dma_aligned int32_t A_CACHE[NR_TASKLETS][BLOCK_ELEMS];
__dma_aligned int32_t B_CACHE[NR_TASKLETS][BLOCK_ELEMS];
__dma_aligned int32_t C_CACHE[NR_TASKLETS][BLOCK_ELEMS];

__mram_noinit int32_t DPU_A[N_ELEMENTS];
__mram_noinit int32_t DPU_B[N_ELEMENTS];
__mram_noinit int32_t DPU_C[N_ELEMENTS];

__host dpu_results_t DPU_RESULTS;

int main()
{
    uint32_t tasklet_id = me();
    dpu_result_t *result = &DPU_RESULTS.tasklet_result[tasklet_id];

    if (tasklet_id == 0)
        perfcounter_config(COUNT_CYCLES, true);

    for (uint32_t elem = tasklet_id * BLOCK_ELEMS; elem < N_ELEMENTS;
         elem += NR_TASKLETS * BLOCK_ELEMS) {

        /* explicit DMA MRAM -> WRAM (the bus traffic a CPU would have had) */
        mram_read(&DPU_A[elem], A_CACHE[tasklet_id], BLOCK_SIZE);
        mram_read(&DPU_B[elem], B_CACHE[tasklet_id], BLOCK_SIZE);

        /* the "kernel": one 32-bit add per element */
        for (uint32_t i = 0; i < BLOCK_ELEMS; i++)
            C_CACHE[tasklet_id][i] = A_CACHE[tasklet_id][i] + B_CACHE[tasklet_id][i];

        /* explicit DMA WRAM -> MRAM */
        mram_write(C_CACHE[tasklet_id], &DPU_C[elem], BLOCK_SIZE);
    }

    result->cycles = (uint32_t)perfcounter_get();
    return 0;
}
