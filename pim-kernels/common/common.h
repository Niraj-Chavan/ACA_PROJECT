/*
 * common/common.h — shared definitions for host and DPU kernels.
 *
 * Both the DPU-side compiler (dpu-upmem-dpurte-clang) and the host compiler
 * include this; MRAM/WRAM symbols live only on the DPU side.
 */
#ifndef COMMON_H
#define COMMON_H

#ifndef NR_TASKLETS
#define NR_TASKLETS 16
#endif

/* MRAM DMA granularity: every mram_read/write must be a multiple of 8 B */
#define BLOCK_SIZE 256 /* bytes per DMA block (64 int32) */

#ifndef N_ELEMENTS
#define N_ELEMENTS (1 << 20) /* 4 MiB per array per DPU */
#endif

#ifndef XSTR
#define XSTR(x) STR(x)
#define STR(x) #x
#endif

/* transferred per DPU to the host at the end of the kernel */
typedef struct {
    uint32_t cycles; /* on-chip cycle counter (perfcounter) */
    int32_t sum;     /* reduction partial result */
} dpu_result_t;

typedef struct {
    dpu_result_t tasklet_result[NR_TASKLETS];
} dpu_results_t;

#endif
