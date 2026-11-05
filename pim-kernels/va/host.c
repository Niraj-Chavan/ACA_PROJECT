/*
 * va/host.c — Vector Add host side.
 *
 * Phases (docs/model-spec.md + analytical model):
 *   copy-in  = input bytes sent to each DPU (dpu_push_xfer)
 *   launch   = dpu_launch
 *   kernel   = on-chip (cycles from perf counters per tasklet)
 *   copy-out = result bytes gathered back
 * VA has no merge phase: element-wise, no partials to combine.
 */
#include <dpu.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "common.h"
#include "host_util.h"

#ifndef DPU_BINARY
#define DPU_BINARY "build/va_dpu"
#endif

#ifndef NR_DPUS
#define NR_DPUS 16
#endif

#define ANSI_COLOR_GREEN "\x1b[32m"
#define ANSI_COLOR_RESET "\x1b[0m"

int main()
{
    struct dpu_set_t dpu_set, dpu;
    uint32_t nr_of_dpus, each_dpu;

    const size_t bytes_per_dpu = N_ELEMENTS * sizeof(int32_t);
    const unsigned long total_in = (unsigned long)bytes_per_dpu * 2 * NR_DPUS;
    const unsigned long total_out = (unsigned long)bytes_per_dpu * NR_DPUS;

    int32_t *A = malloc(bytes_per_dpu * NR_DPUS);
    int32_t *B = malloc(bytes_per_dpu * NR_DPUS);
    int32_t *C = malloc(bytes_per_dpu * NR_DPUS);
    if (!A || !B || !C) {
        fprintf(stderr, "oom\n");
        return -1;
    }
    srand(0);
    for (size_t i = 0; i < bytes_per_dpu * NR_DPUS / sizeof(int32_t); i++) {
        A[i] = (int32_t)rand() % 256 - 128;
        B[i] = (int32_t)rand() % 256 - 128;
    }

    double t0 = hu_now_ms();
    DPU_ASSERT(dpu_alloc(NR_DPUS, NULL, &dpu_set));
    DPU_ASSERT(dpu_load(dpu_set, DPU_BINARY, NULL));
    DPU_ASSERT(dpu_get_nr_dpus(dpu_set, &nr_of_dpus));
    hu_emit_phase("alloc_load", hu_now_ms() - t0, 0);
    hu_emit_meta("VA", nr_of_dpus, NR_TASKLETS, (long long)N_ELEMENTS * nr_of_dpus,
        (long long)N_ELEMENTS * nr_of_dpus);
    printf("Allocated %u DPU(s), %u elements each (%.1f MiB per array)\n",
        nr_of_dpus, N_ELEMENTS, (double)bytes_per_dpu / (1024 * 1024));

    /* ---- copy-in: input bytes cross the same bus PIM aims to avoid ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, A + each_dpu * N_ELEMENTS));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(DPU_A), 0, bytes_per_dpu, DPU_XFER_DEFAULT));
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, B + each_dpu * N_ELEMENTS));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(DPU_B), 0, bytes_per_dpu, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_in", hu_now_ms() - t0, total_in);

    /* ---- launch ---- */
    t0 = hu_now_ms();
    DPU_ASSERT(dpu_launch(dpu_set, DPU_SYNCHRONOUS));
    hu_emit_phase("launch", hu_now_ms() - t0, 0);

    /* ---- copy-out ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, C + each_dpu * N_ELEMENTS));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(DPU_C), 0, bytes_per_dpu, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_out", hu_now_ms() - t0, total_out);

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

    size_t errors = 0;
    for (size_t i = 0; i < bytes_per_dpu * nr_of_dpus / sizeof(int32_t); i++)
        if (C[i] != A[i] + B[i])
            errors++;
    printf("elements = %zu, bytes moved in = %.1f MiB, out = %.1f MiB\n",
        (size_t)bytes_per_dpu * nr_of_dpus / sizeof(int32_t),
        (double)total_in / (1024 * 1024), (double)total_out / (1024 * 1024));
    printf("DPU kernel (max across tasklets) = %u cycles\n", max_cycles);
    printf("errors vs CPU result = %zu %s\n", errors,
        errors == 0 ? "[" ANSI_COLOR_GREEN "OK" ANSI_COLOR_RESET "]" : "[FAILED]");

    DPU_ASSERT(dpu_free(dpu_set));
    free(A);
    free(B);
    free(C);
    return errors == 0 ? 0 : -1;
}
