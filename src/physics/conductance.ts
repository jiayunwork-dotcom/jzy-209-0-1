import { molecularConductance, viscousConductanceCoefficient } from './gas';
import type { GasSpecies } from '../types';

/**
 * Conductance model for a long straight circular tube.
 *
 * The transition regime is represented by adding molecular and viscous
 * contributions (a common Knudsen interpolation). It has the correct limits:
 * - low mean pressure: molecular conductance is pressure-independent;
 * - high mean pressure: C_v = k_v * p_mean (Poiseuille flow).
 *
 * C_m and C_v are returned separately because derivatives with respect to
 * endpoint pressures are needed by Newton's method.
 */
export interface TubeModel {
  molecular: number;
  viscousCoefficient: number;
}

export function createTubeModel(
  diameterCm: number,
  lengthCm: number,
  gas: GasSpecies,
  temperature: number
): TubeModel {
  return {
    molecular: molecularConductance(diameterCm, lengthCm, gas, temperature),
    viscousCoefficient: viscousConductanceCoefficient(diameterCm, lengthCm, gas, temperature)
  };
}

/** Total conductance at mean pressure. */
export function tubeConductance(model: TubeModel, meanPressure: number): number {
  return model.molecular + model.viscousCoefficient * meanPressure;
}

/**
 * Signed throughput from node i to node j in mbar*L/s.
 * Positive value means flow i -> j.
 */
export function tubeFlow(model: TubeModel, pi: number, pj: number): number {
  const mean = 0.5 * (pi + pj);
  return (model.molecular + model.viscousCoefficient * mean) * (pi - pj);
}

/**
 * Partial derivatives of signed flow i->j with respect to pi and pj.
 */
export function tubeFlowDerivatives(
  model: TubeModel,
  pi: number,
  pj: number
): { dpi: number; dpj: number } {
  const mean = 0.5 * (pi + pj);
  const c = model.molecular + model.viscousCoefficient * mean;
  const halfK = 0.5 * model.viscousCoefficient;
  const delta = pi - pj;
  // dQ/dpi = C + k/2*(pi-pj)
  // dQ/dpj = -C + k/2*(pi-pj)
  return {
    dpi: c + halfK * delta,
    dpj: -c + halfK * delta
  };
}

/** Harmonic series conductance; zero if any segment is zero. */
export function seriesConductance(conductances: number[]): number {
  if (conductances.some((c) => c <= 0)) return 0;
  const reciprocalSum = conductances.reduce((sum, c) => sum + 1 / c, 0);
  return 1 / reciprocalSum;
}

/** Parallel conductance is the sum. */
export function parallelConductance(conductances: number[]): number {
  return conductances.reduce((sum, c) => sum + c, 0);
}
