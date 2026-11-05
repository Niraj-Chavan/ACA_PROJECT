/*
 * common/host_util.h — host-side instrumentation shared by all kernels.
 *
 * Emits one JSON line per event on stderr (the dashboard's data source):
 *   {"event":"meta", "kernel":"VA", "dpus":16, "tasklets":16, "n":16777216, "ops":16777216}
 *   {"event":"phase","name":"copy_in","ms":7.9,"bytes":134217728}
 *   {"event":"dpu",  "cycles":12812752, "dpus":16}
 * The `n` in meta maps 1:1 to the analytical model's n so the dashboard can
 * lay measured and predicted values side by side.
 */
#ifndef HOST_UTIL_H
#define HOST_UTIL_H

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200112L
#endif

static double hu_now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void hu_emit_phase(const char *name, double ms, unsigned long bytes)
{
    if (getenv("PIM_EVENTS") && !strcmp(getenv("PIM_EVENTS"), "0"))
        return;
    fprintf(stderr, "{\"event\":\"phase\",\"name\":\"%s\",\"ms\":%.3f,\"bytes\":%lu}\n",
        name, ms, bytes);
    fflush(stderr);
}

static void hu_emit_meta(const char *kernel, unsigned int dpus, unsigned int tasklets,
    long long n, long long ops)
{
    fprintf(stderr,
        "{\"event\":\"meta\",\"kernel\":\"%s\",\"dpus\":%u,\"tasklets\":%u,"
        "\"n\":%lld,\"ops\":%lld}\n",
        kernel, dpus, tasklets, n, ops);
    fflush(stderr);
}

static void hu_emit_dpu(unsigned int cycles, unsigned int dpus)
{
    fprintf(stderr, "{\"event\":\"dpu\",\"cycles\":%u,\"dpus\":%u}\n", cycles, dpus);
    fflush(stderr);
}

#endif
