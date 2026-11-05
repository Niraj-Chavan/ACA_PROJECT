/*
 * gemv/host.c — Matrix–vector multiply, host side (headline PIM kernel).
 *
 * copy-in  = matrix slice + the FULL vector x to every DPU
 *            (dpu_push_xfer of the same-source x to all: the broadcast the
 *             model counts as part of the kernel input, not the merge)
 * launch   = dpu_launch
 * kernel   = d MACs per row — multiply-bound on UPMEM's ISA (mul in software)
 * copy-out = y rows gathered back (4 bytes per row per unit)
 * merge    = none: each unit owns whole rows.
 */
#include <dpu.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "common.h"
#include "host_util.h"

#ifndef DPU_BINARY
#define DPU_BINARY "build/gemv_dpu"
#endif

#ifndef NR_DPUS
#define NR_DPUS 16
#endif

/* keep in sync with gemv/dpu.c */
#define GEMV_D 1024
#define ROWS_PER_DPU 1024

#define ANSI_COLOR_GREEN "\x1b[32m"
#define ANSI_COLOR_RESET "\x1b[0m"

int main()
{
    struct dpu_set_t dpu_set, dpu;
    uint32_t nr_of_dpus, each_dpu;

    const size_t matrix_bytes_per_dpu = (size_t)ROWS_PER_DPU * GEMV_D * 4;
    const size_t x_bytes = (size_t)GEMV_D * 4;
    const size_t matrix_total = matrix_bytes_per_dpu * NR_DPUS;

    int32_t *A = malloc(matrix_total);
    int32_t *x = malloc(x_bytes);
    int32_t *Y = malloc(x_bytes * NR_DPUS); /* each DPU's ROWS_PER_DPU outputs */
    if (!A || !x || !Y) {
        fprintf(stderr, "oom\n");
        return -1;
    }
    srand(0);
    for (size_t i = 0; i < matrix_total / sizeof(int32_t); i++)
        A[i] = (int32_t)rand() % 64 - 32;
    for (size_t i = 0; i < GEMV_D; i++)
        x[i] = (int32_t)rand() % 64 - 32;

    double t0 = hu_now_ms();
    DPU_ASSERT(dpu_alloc(NR_DPUS, NULL, &dpu_set));
    DPU_ASSERT(dpu_load(dpu_set, DPU_BINARY, NULL));
    DPU_ASSERT(dpu_get_nr_dpus(dpu_set, &nr_of_dpus));
    hu_emit_phase("alloc_load", hu_now_ms() - t0, 0);
    hu_emit_meta("GEMV", nr_of_dpus, NR_TASKLETS,
        (long long)ROWS_PER_DPU * GEMV_D * nr_of_dpus,
        (long long)2 * ROWS_PER_DPU * GEMV_D * nr_of_dpus);
    printf("Allocated %u DPU(s): %u rows × %u cols each (d = %u everywhere)\n",
        nr_of_dpus, ROWS_PER_DPU, GEMV_D, GEMV_D);

    /* ---- copy-in: matrix slice per DPU + full x broadcast to every DPU ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, A + each_dpu * ROWS_PER_DPU * GEMV_D));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(A_MRAM), 0,
        matrix_bytes_per_dpu, DPU_XFER_DEFAULT));
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, x));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(X_MRAM), 0, x_bytes, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_in", hu_now_ms() - t0, matrix_total + x_bytes * NR_DPUS);

    /* ---- launch ---- */
    t0 = hu_now_ms();
    DPU_ASSERT(dpu_launch(dpu_set, DPU_SYNCHRONOUS));
    hu_emit_phase("launch", hu_now_ms() - t0, 0);

    /* ---- copy-out: y rows ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, Y + each_dpu * ROWS_PER_DPU));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(Y_MRAM), 0,
        ROWS_PER_DPU * 4, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_out", hu_now_ms() - t0, ROWS_PER_DPU * 4 * NR_DPUS);

    /* per-DPU kernel cycles from on-chip performance counters */
    dpu_results_t results[NR_DPUS];
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, &results[each_dpu]));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(DPU_RESULTS), 0,
        sizeof(dpu_results_t), DPU_XFER_DEFAULT));

    uint32_t max_cycles = 0;
    for (uint32_t d = 0; d < nr_of_dpus; d++)
        for (unsigned int tl = 0; tl < NR_TASKLETS; tl++)
            if (results[d].tasklet_result[tl].cycles > max_cycles)
                max_cycles = results[d].tasklet_result[tl].cycles;
    hu_emit_dpu(max_cycles, nr_of_dpus);

    /* ---- correctness: CPU computes the same dot products ---- */
    size_t errors = 0;
    for (uint32_t d = 0; d < nr_of_dpus; d++) {
        for (uint32_t r = 0; r < ROWS_PER_DPU; r++) {
            const int32_t *row = A + ((size_t)d * ROWS_PER_DPU + r) * GEMV_D;
            int32_t acc = 0;
            for (uint32_t k = 0; k < GEMV_D; k++)
                acc += row[k] * x[k];
            if (Y[d * ROWS_PER_DPU + r] != acc)
                errors++;
        }
    }
    printf("rows = %u × DPUs, matrix traffic in = %.1f MiB, out = %u KiB\n",
        ROWS_PER_DPU * nr_of_dpus, (double)matrix_total / (1024 * 1024),
        ROWS_PER_DPU * 4 * nr_of_dpus / 1024);
    printf("DPU kernel (max across tasklets) = %u cycles\n", max_cycles);
    printf("errors vs CPU result = %zu %s\n", errors,
        errors == 0 ? "[" ANSI_COLOR_GREEN "OK" ANSI_COLOR_RESET "]" : "[FAILED]");

    DPU_ASSERT(dpu_free(dpu_set));
    free(A);
    free(x);
    free(Y);
    return errors == 0 ? 0 : -1;
}
