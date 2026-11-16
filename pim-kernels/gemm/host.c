/*
 * gemm/host.c — Tiled matrix multiply host side.
 *
 * copy-in  = A and B slices for every DPU
 * launch   = dpu_launch (includes the intra-DPU barrier)
 * kernel   = 2 · GEMM_N³ multiply-accumulates per DPU
 * copy-out = C slice per DPU
 * merge    = none: each DPU owns whole rows of C
 */
#include <dpu.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "common.h"
#include "host_util.h"

#ifndef DPU_BINARY
#define DPU_BINARY "build/gemm_dpu"
#endif

#ifndef NR_DPUS
#define NR_DPUS 16
#endif

#define GEMM_N 100

#define ANSI_COLOR_GREEN "\x1b[32m"
#define ANSI_COLOR_RESET "\x1b[0m"

int main()
{
    struct dpu_set_t dpu_set, dpu;
    uint32_t nr_of_dpus, each_dpu;

    const size_t matrix_elems = (size_t)GEMM_N * GEMM_N;
    const size_t matrix_bytes = matrix_elems * sizeof(int32_t);
    const unsigned long total_in = (unsigned long)matrix_bytes * 2 * NR_DPUS;
    const unsigned long total_out = (unsigned long)matrix_bytes * NR_DPUS;

    int32_t *A = malloc(matrix_bytes * NR_DPUS);
    int32_t *B = malloc(matrix_bytes * NR_DPUS);
    int32_t *C = malloc(matrix_bytes * NR_DPUS);
    if (!A || !B || !C) {
        fprintf(stderr, "oom\n");
        return -1;
    }
    srand(0);
    for (size_t i = 0; i < matrix_elems * NR_DPUS; i++) {
        A[i] = (int32_t)rand() % 16 - 8;
        B[i] = (int32_t)rand() % 16 - 8;
    }

    double t0 = hu_now_ms();
    DPU_ASSERT(dpu_alloc(NR_DPUS, NULL, &dpu_set));
    DPU_ASSERT(dpu_load(dpu_set, DPU_BINARY, NULL));
    DPU_ASSERT(dpu_get_nr_dpus(dpu_set, &nr_of_dpus));
    hu_emit_phase("alloc_load", hu_now_ms() - t0, 0);
    hu_emit_meta("GEMM", nr_of_dpus, NR_TASKLETS,
        (long long)GEMM_N * GEMM_N * GEMM_N * nr_of_dpus,
        (long long)2 * GEMM_N * GEMM_N * GEMM_N * nr_of_dpus);
    printf("Allocated %u DPU(s), %u×%u matrices, %u MACs each\n",
        nr_of_dpus, GEMM_N, GEMM_N, GEMM_N * GEMM_N * GEMM_N);

    /* ---- copy-in: A and B slices ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, A + each_dpu * matrix_elems));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(A_MRAM), 0, matrix_bytes, DPU_XFER_DEFAULT));
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, B + each_dpu * matrix_elems));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(B_MRAM), 0, matrix_bytes, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_in", hu_now_ms() - t0, total_in);

    /* ---- launch ---- */
    t0 = hu_now_ms();
    DPU_ASSERT(dpu_launch(dpu_set, DPU_SYNCHRONOUS));
    hu_emit_phase("launch", hu_now_ms() - t0, 0);

    /* ---- copy-out: C slices ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, C + each_dpu * matrix_elems));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(C_MRAM), 0, matrix_bytes, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_out", hu_now_ms() - t0, total_out);

    uint32_t max_cycles = 0;
    dpu_results_t results[NR_DPUS];
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, &results[each_dpu]));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(DPU_RESULTS), 0,
        sizeof(dpu_results_t), DPU_XFER_DEFAULT));
    for (uint32_t d = 0; d < nr_of_dpus; d++)
        for (unsigned int tl = 0; tl < NR_TASKLETS; tl++)
            if (results[d].tasklet_result[tl].cycles > max_cycles)
                max_cycles = results[d].tasklet_result[tl].cycles;
    hu_emit_dpu(max_cycles, nr_of_dpus);

    /* ---- correctness: CPU reference triple loop ---- */
    size_t errors = 0;
    for (uint32_t d = 0; d < nr_of_dpus; d++) {
        const int32_t *a = A + d * matrix_elems;
        const int32_t *b = B + d * matrix_elems;
        const int32_t *c = C + d * matrix_elems;
        for (uint32_t r = 0; r < GEMM_N; r++) {
            for (uint32_t j = 0; j < GEMM_N; j++) {
                int32_t acc = 0;
                for (uint32_t k = 0; k < GEMM_N; k++)
                    acc += a[r * GEMM_N + k] * b[k * GEMM_N + j];
                if (c[r * GEMM_N + j] != acc)
                    errors++;
            }
        }
    }
    printf("matrices = %u × %u×%u, traffic in = %.1f MiB, out = %.1f MiB\n",
        nr_of_dpus, GEMM_N, GEMM_N, (double)total_in / (1024 * 1024),
        (double)total_out / (1024 * 1024));
    printf("DPU kernel (max across tasklets) = %u cycles\n", max_cycles);
    printf("errors vs CPU result = %zu %s\n", errors,
        errors == 0 ? "[" ANSI_COLOR_GREEN "OK" ANSI_COLOR_RESET "]" : "[FAILED]");

    DPU_ASSERT(dpu_free(dpu_set));
    free(A);
    free(B);
    free(C);
    return errors == 0 ? 0 : -1;
}
