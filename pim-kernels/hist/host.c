/*
 * hist/host.c — 256-bin histogram host side.
 *
 * copy-in  = input array sliced across DPUs
 * launch   = dpu_launch (includes the intra-DPU barrier)
 * kernel   = 256-bin increments, private histogram per tasklet
 * copy-out = one 256-bin partial per DPU (1 KiB each)
 * merge    = host adds P × 256 bins — the model's merge term
 */
#include <dpu.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "common.h"
#include "host_util.h"

#ifndef DPU_BINARY
#define DPU_BINARY "build/hist_dpu"
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
    const unsigned long total_in = (unsigned long)bytes_per_dpu * NR_DPUS;

    int32_t *A = malloc(bytes_per_dpu * NR_DPUS);
    if (!A) {
        fprintf(stderr, "oom\n");
        return -1;
    }
    srand(0);
    for (size_t i = 0; i < bytes_per_dpu * NR_DPUS / sizeof(int32_t); i++)
        A[i] = (int32_t)rand() % HIST_BINS;

    double t0 = hu_now_ms();
    DPU_ASSERT(dpu_alloc(NR_DPUS, NULL, &dpu_set));
    DPU_ASSERT(dpu_load(dpu_set, DPU_BINARY, NULL));
    DPU_ASSERT(dpu_get_nr_dpus(dpu_set, &nr_of_dpus));
    hu_emit_phase("alloc_load", hu_now_ms() - t0, 0);
    hu_emit_meta("HIST", nr_of_dpus, NR_TASKLETS, (long long)N_ELEMENTS * nr_of_dpus,
        (long long)3 * N_ELEMENTS * nr_of_dpus);
    printf("Allocated %u DPU(s), %u elements each, %d bins\n",
        nr_of_dpus, N_ELEMENTS, HIST_BINS);

    /* ---- copy-in ---- */
    t0 = hu_now_ms();
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, A + each_dpu * N_ELEMENTS));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_TO_DPU, XSTR(H_INPUT), 0, bytes_per_dpu, DPU_XFER_DEFAULT));
    hu_emit_phase("copy_in", hu_now_ms() - t0, total_in);

    /* ---- launch ---- */
    t0 = hu_now_ms();
    DPU_ASSERT(dpu_launch(dpu_set, DPU_SYNCHRONOUS));
    hu_emit_phase("launch", hu_now_ms() - t0, 0);

    /* ---- copy-out: one 256-bin partial per DPU ---- */
    t0 = hu_now_ms();
    hist_result_t *results = malloc(sizeof(hist_result_t) * NR_DPUS);
    if (!results) {
        fprintf(stderr, "oom\n");
        DPU_ASSERT(dpu_free(dpu_set));
        free(A);
        return -1;
    }
    DPU_FOREACH (dpu_set, dpu, each_dpu) {
        DPU_ASSERT(dpu_prepare_xfer(dpu, &results[each_dpu]));
    }
    DPU_ASSERT(dpu_push_xfer(dpu_set, DPU_XFER_FROM_DPU, XSTR(DPU_HIST), 0,
        sizeof(hist_result_t), DPU_XFER_DEFAULT));
    hu_emit_phase("copy_out", hu_now_ms() - t0, (unsigned long)sizeof(hist_result_t) * nr_of_dpus);

    uint32_t max_cycles = 0;
    for (uint32_t d = 0; d < nr_of_dpus; d++)
        if (results[d].cycles > max_cycles)
            max_cycles = results[d].cycles;
    hu_emit_dpu(max_cycles, nr_of_dpus);

    /* ---- merge: host adds P × 256 bins ---- */
    t0 = hu_now_ms();
    uint32_t merged[HIST_BINS] = {0};
    for (uint32_t d = 0; d < nr_of_dpus; d++)
        for (uint32_t bin = 0; bin < HIST_BINS; bin++)
            merged[bin] += results[d].bins[bin];
    double merge_ms = hu_now_ms() - t0;
    hu_emit_phase("merge", merge_ms, (unsigned long)nr_of_dpus * HIST_BINS * 4);

    /* ---- correctness: CPU histogram ---- */
    size_t errors = 0;
    uint32_t *cpu_hist = calloc(HIST_BINS, sizeof(uint32_t));
    if (!cpu_hist) {
        fprintf(stderr, "oom\n");
        DPU_ASSERT(dpu_free(dpu_set));
        free(A);
        free(results);
        return -1;
    }
    for (size_t i = 0; i < bytes_per_dpu * nr_of_dpus / sizeof(int32_t); i++)
        cpu_hist[A[i] & (HIST_BINS - 1)]++;
    for (uint32_t bin = 0; bin < HIST_BINS; bin++)
        if (merged[bin] != cpu_hist[bin])
            errors++;

    printf("elements = %zu, input traffic = %.1f MiB, bins = %d\n",
        bytes_per_dpu * nr_of_dpus / sizeof(int32_t), (double)total_in / (1024 * 1024),
        HIST_BINS);
    printf("DPU kernel (max across tasklets) = %u cycles, host merge = %.3f ms\n",
        max_cycles, merge_ms);
    printf("histogram bins differ = %zu %s\n", errors,
        errors == 0
            ? "[" ANSI_COLOR_GREEN "OK" ANSI_COLOR_RESET "]"
            : "[FAILED]");

    DPU_ASSERT(dpu_free(dpu_set));
    free(A);
    free(results);
    free(cpu_hist);
    return errors == 0 ? 0 : -1;
}
