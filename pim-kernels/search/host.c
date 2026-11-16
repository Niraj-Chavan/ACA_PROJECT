/*
 * search/host.c — Parallel array search host side.
 *
 * copy-in  = input array sliced across DPUs
 * launch   = dpu_launch (includes the intra-DPU barrier)
 * kernel   = compare + count
 * copy-out = one 4-byte count per DPU
 * merge    = host adds the per-DPU counts
 */
#include <dpu.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "common.h"
#include "host_util.h"

#ifndef DPU_BINARY
#define DPU_BINARY "build/search_dpu"
#endif

#ifndef NR_DPUS
#define NR_DPUS 16
#endif

#define SEARCH_TARGET 42

#define ANSI_COLOR_GREEN "\x1b[32m"
#define ANSI_COLOR_RESET "\x1b[0m"

int main()
{
    struct dpu_set_t dpu_set, dpu;
    uint32_t nr_of_dpus, each_dpu;

    const size_t bytes_per_dpu = N_ELEMENTS * sizeof(int32_t);
    const unsigned long total_in = (unsigned long)bytes_per_dpu * NR_DPUS;

    int32_t *A = malloc(bytes_per_dpu * NR_DPUS);
    if (!A) {
        fprintf(stderr, "oom\n");
        return -1;
    }
    srand(0);
    for (size_t i = 0; i < bytes_per_dpu * NR_DPUS / sizeof(int32_t); i++)
        A[i] = (int32_t)rand() % 256;

    double t0 = hu_now_ms();
    DPU_ASSERT(dpu_alloc(NR_DPUS, NULL, &dpu_set));
    DPU_ASSERT(dpu_load(dpu_set, DPU_BINARY, NULL));
    DPU_ASSERT(dpu_get_nr_dpus(dpu_set, &nr_of_dpus));
    hu_emit_phase("alloc_load", hu_now_ms() - t0, 0);
    hu_emit_meta("SEARCH", nr_of_dpus, NR_TASKLETS, (long long)N_ELEMENTS * nr_of_dpus,
        (long long)2 * N_ELEMENTS * nr_of_dpus);
    printf("Allocated %u DPU(s), %u elements each, target = %d\n",
        nr_of_dpus, N_ELEMENTS, SEARCH_TARGET);

    /* ---- copy-in ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, A + each_dpu * N_ELEMENTS));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(S_INPUT), 0, bytes_per_dpu, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_in", hu_now_ms() - t0, total_in);

    /* ---- launch ---- */
    t0 = hu_now_ms();
    DPU_ASSERT(dpu_launch(dpu_set, DPU_SYNCHRONOUS));
    hu_emit_phase("launch", hu_now_ms() - t0, 0);

    /* ---- copy-out: one count per DPU ---- */
    t0 = hu_now_ms();
    dpu_results_t results[NR_DPUS];
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, &results[each_dpu]));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(DPU_RESULTS), 0,
        sizeof(dpu_results_t), DPU_XFER_DEFAULT));
    hu_emit_phase("copy_out", hu_now_ms() - t0, (unsigned long)nr_of_dpus * 4);

    uint32_t max_cycles = 0;
    for (uint32_t d = 0; d < nr_of_dpus; d++)
        if (results[d].tasklet_result[0].cycles > max_cycles)
            max_cycles = results[d].tasklet_result[0].cycles;
    hu_emit_dpu(max_cycles, nr_of_dpus);

    /* ---- merge: host adds the per-DPU counts ---- */
    t0 = hu_now_ms();
    int32_t total = 0;
    for (uint32_t d = 0; d < nr_of_dpus; d++)
        total += results[d].tasklet_result[0].sum;
    double merge_ms = hu_now_ms() - t0;
    hu_emit_phase("merge", merge_ms, (unsigned long)nr_of_dpus * 4);

    /* ---- correctness ---- */
    size_t errors = 0;
    int32_t cpu_count = 0;
    for (size_t i = 0; i < bytes_per_dpu * nr_of_dpus / sizeof(int32_t); i++)
        cpu_count += (A[i] == SEARCH_TARGET);
    if (total != cpu_count)
        errors++;

    printf("elements = %zu, input traffic = %.1f MiB\n",
        bytes_per_dpu * nr_of_dpus / sizeof(int32_t), (double)total_in / (1024 * 1024));
    printf("DPU kernel (max across tasklets) = %u cycles\n", max_cycles);
    printf("PIM matches = %d, CPU matches = %d (%s)\n", total, cpu_count,
        errors == 0
            ? "[" ANSI_COLOR_GREEN "OK" ANSI_COLOR_RESET "]"
            : "[FAILED]");

    DPU_ASSERT(dpu_free(dpu_set));
    free(A);
    return errors == 0 ? 0 : -1;
}
