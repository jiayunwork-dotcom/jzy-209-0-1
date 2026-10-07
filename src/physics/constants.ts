import type { GasSpecies } from '../types';

export const GAS_KIND: Record<GasSpecies, true> = {
  air: true,
  N2: true,
  O2: true,
  Ar: true,
  He: true,
  H2: true,
  CO2: true
};

export const DEFAULT_INITIAL_PRESSURE = 1013.25;
export const DEFAULT_MAX_ITERATIONS = 100;
export const DEFAULT_RESIDUAL_TOLERANCE = 1e-8;
export const DEFAULT_TRANSIENT_MAX_TIME = 1e7;
export const DEFAULT_MIN_STEP = 1e-10;
export const DEFAULT_MAX_STEP = 1000;
export const MAX_CURVE_POINTS = 2000;
