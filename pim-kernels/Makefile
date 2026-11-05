# Kernels compiled for the real UPMEM DPU instruction set.
#   make va   | make gemv   | make red     (or: make all)
# Requires: source ../../upmem-env.sh first (adds SDK + compatibility libs to PATH)
#
# `LIBDPU_PY` lets libdpu.so resolve the interpreter available on modern
# Ubuntu; the SDK was built for Ubuntu 20.04.

NR_TASKLETS ?= 16
NR_DPUS ?= 16

BUILDDIR := build
LIBDPU_PY := -lpython3.14

COMMON_FLAGS := -Wall -Wextra -Werror -g -Icommon
DPU_CFLAGS := ${COMMON_FLAGS} -O2 -DNR_TASKLETS=${NR_TASKLETS}
HOST_CFLAGS := ${COMMON_FLAGS} -std=c11 -O3 -D_POSIX_C_SOURCE=200112L `dpu-pkg-config --cflags --libs dpu` ${LIBDPU_PY} -DNR_TASKLETS=${NR_TASKLETS}

KERNELS := va gemv red

TARGETS := $(addprefix ${BUILDDIR}/,$(addsuffix _done,${KERNELS}))

.PHONY: all clean ${KERNELS} FORCE

all: ${TARGETS}

# The binaries bake in NR_DPUS (host allocation size, DPU launch width), so a
# different DPU count must never reuse a previous build. Compiles here are
# sub-second, so always rebuild rather than risk a stale binary.
FORCE:

va: ${BUILDDIR}/va_done
gemv: ${BUILDDIR}/gemv_done
red: ${BUILDDIR}/red_done

define KERNEL_template =
${BUILDDIR}/$(1)_done: FORCE $(1)/dpu.c $(1)/host.c common/common.h common/host_util.h
	@mkdir -p ${BUILDDIR}
	dpu-upmem-dpurte-clang ${DPU_CFLAGS} -DNR_DPUS=${NR_DPUS} -o ${BUILDDIR}/$(1)_dpu $(1)/dpu.c
	cc $(1)/host.c ${HOST_CFLAGS} -DNR_DPUS=${NR_DPUS} -o ${BUILDDIR}/$(1)_host
	@touch $$@
endef

$(foreach k,${KERNELS},$(eval $(call KERNEL_template,$(k))))

run_va: va
	PIM_EVENTS=1 ${BUILDDIR}/va_host 2>${BUILDDIR}/va_events.jsonl

run_gemv: gemv
	PIM_EVENTS=1 ${BUILDDIR}/gemv_host 2>${BUILDDIR}/gemv_events.jsonl

run_red: red
	PIM_EVENTS=1 ${BUILDDIR}/red_host 2>${BUILDDIR}/red_events.jsonl

clean:
	rm -Rf ${BUILDDIR}
