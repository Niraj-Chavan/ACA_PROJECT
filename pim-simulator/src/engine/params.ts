import type { Params } from './types'

/**
 * Presets from Appendix B.
 * Sources: UPMEM-like values approximate PrIM measurements (Gómez-Luna et al.);
 * HBM-PIM values are modelled on Samsung Aquabolt-XL; the off-chip energy is in
 * the range reported for DDR access (Horowitz, ISSCC 2014).
 */

export const mockupPreset: Params = {
  preset: 'mockup',
  cpu: { freqGHz: 3.5, cores: 8, opsPerCycle: 4, memBWGBs: 25, memLatencyNs: 100, mlp: 10 },
  pim: {
    banks: 8,
    unitsPerBank: 1,
    freqGHz: 1.0,
    opsPerCycle: 1,
    bankBWGBs: 8,
    copyBWGBs: 25,
    mulCost: 1,
    launchUs: 50,
    syncUs: 20,
  },
  energy: {
    offchipPJperB: 160,
    inbankPJperB: 25,
    cpuPJperOp: 40,
    pimPJperOp: 10,
    cpuStaticW: 65,
    cpuIdleW: 15,
    pimUnitW: 0.06,
  },
  // Mockup default: data lives in PIM banks and the result stays there
  // (worked example Phase 1: T_PIM resident ≈ 25.3 ms → speedup ≈ 2.56×).
  // Copy-out enters when the user asks for the result on the host.
  dataResident: true,
  resultNeededOnHost: false,
}

export const upmemPreset: Params = {
  ...mockupPreset,
  preset: 'upmem',
  cpu: { freqGHz: 3.3, cores: 4, opsPerCycle: 8, memBWGBs: 38.4, memLatencyNs: 100, mlp: 10 },
  pim: {
    banks: 2560,
    unitsPerBank: 1,
    freqGHz: 0.35,
    opsPerCycle: 0.166, // ≈ 58 MOPS add per DPU
    bankBWGBs: 0.63,
    copyBWGBs: 6,
    mulCost: 5.7,
    launchUs: 50,
    syncUs: 20,
  },
  energy: { ...mockupPreset.energy },
  resultNeededOnHost: true, // PrIM benchmarks read results back through the host
}

export const hbmpimPreset: Params = {
  ...mockupPreset,
  preset: 'hbmpim',
  cpu: { freqGHz: 1.4, cores: 108, opsPerCycle: 128, memBWGBs: 1200, memLatencyNs: 120, mlp: 64 },
  pim: {
    banks: 512,
    unitsPerBank: 1,
    freqGHz: 0.3,
    opsPerCycle: 16,
    bankBWGBs: 9.4,
    copyBWGBs: 1200,
    mulCost: 1,
    launchUs: 5,
    syncUs: 2,
  },
  energy: {
    offchipPJperB: 31,
    inbankPJperB: 8,
    cpuPJperOp: 8,
    pimPJperOp: 3,
    cpuStaticW: 150,
    cpuIdleW: 60,
    pimUnitW: 0.02,
  },
}

export const presets: Record<Params['preset'], Params> = {
  mockup: mockupPreset,
  upmem: upmemPreset,
  hbmpim: hbmpimPreset,
}

export const defaultParams: Params = JSON.parse(JSON.stringify(mockupPreset))

export const PRESET_LABELS: Record<Params['preset'], string> = {
  mockup: 'Simple (mockup)',
  upmem: 'UPMEM-like (2560 DPUs)',
  hbmpim: 'HBM-PIM-like (Samsung)',
}
