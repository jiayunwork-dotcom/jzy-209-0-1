import type { FlowRegime, GasSpecies } from '../types';
import { dynamicViscosity, meanFreePath, meanMolecularSpeed, MBAR_TO_PA } from './gas';

/**
 * Conductance of a long circular tube.
 *
 * Molecular flow (Knudsen), long-tube transmission probability:
 *   C_mol = vbar * pi * d^3 / (12 L)          [m^3/s]
 * which for air at 20 C evaluates to 12.1 * d_mm^3 / L_m  [L/s]
 * (the reference value: d = 25 mm, L = 1 m  ->  ~1.89 L/s).
 *
 * Viscous (laminar, Poiseuille) flow:
 *   Q = pi d^4 (p1^2 - p2^2) / (256 eta L)
 *   C_visc = Q/(p1-p2) = pi d^4 (p1+p2)/(256 eta L)   [m^3/s]
 *
 * Transition regime: the additive Knudsen form C = C_mol + C_visc joins the
 * two limits continuously. It is an engineering correlation (rather than a
 * Knudsen-number fitted formula); it satisfies the requirements that the
 * molecular limit is pressure independent and the viscous contribution scales
 * linearly with mean pressure.
 */
export interface PipeConductance {
  totalLps: number;
  molecularLps: number;
  viscousLps: number;
  regime: FlowRegime;
  knudsenNumber: number;
}

/** Molecular conductance of a long circular tube, in L/s. */
export function pipeMolecularConductanceLps(
  diameterM: number,
  lengthM: number,
  species: GasSpecies,
  temperatureK: number
): number {
  const vbar = meanMolecularSpeed(species, temperatureK); // m/s
  const m3ps = (vbar * Math.PI * diameterM * diameterM * diameterM) / (12 * lengthM);
  return m3ps * 1000; // m^3/s -> L/s
}

/** Viscous (laminar) conductance of a long circular tube at a mean pressure, in L/s. */
export function pipeViscousConductanceLps(
  diameterM: number,
  lengthM: number,
  species: GasSpecies,
  temperatureK: number,
  meanPressureMbar: number
): number {
  const eta = dynamicViscosity(species, temperatureK); // Pa s
  const pSumPa = Math.max(meanPressureMbar, 0) * 2 * MBAR_TO_PA; // p1 + p2
  const m3ps = (Math.PI * diameterM ** 4 * pSumPa) / (256 * eta * lengthM);
  return m3ps * 1000;
}

/** Flow regime from the Knudsen number Kn = lambda / d. */
export function regimeFromKnudsen(kn: number): FlowRegime {
  if (kn > 1) return 'molecular';
  if (kn < 0.01) return 'viscous';
  return 'transition';
}

export function pipeConductanceAtMeanPressure(
  diameterM: number,
  lengthM: number,
  species: GasSpecies,
  temperatureK: number,
  meanPressureMbar: number
): PipeConductance {
  const molecularLps = pipeMolecularConductanceLps(diameterM, lengthM, species, temperatureK);
  const viscousLps = pipeViscousConductanceLps(diameterM, lengthM, species, temperatureK, meanPressureMbar);
  const lambda = meanFreePath(species, temperatureK, Math.max(meanPressureMbar, 1e-20));
  const kn = lambda / diameterM;
  return {
    totalLps: molecularLps + viscousLps,
    molecularLps,
    viscousLps,
    regime: regimeFromKnudsen(kn),
    knudsenNumber: kn
  };
}

/**
 * Series combination of conductances: 1/C = sum 1/C_i. Zero/closed elements
 * give zero. Used for reporting and tests.
 */
export function seriesConductance(conductancesLps: number[]): number {
  let inv = 0;
  for (const c of conductancesLps) {
    if (!(c > 0)) return 0;
    inv += 1 / c;
  }
  return inv > 0 ? 1 / inv : 0;
}

/** Parallel combination: C = sum C_i. */
export function parallelConductance(conductancesLps: number[]): number {
  return conductancesLps.reduce((a, b) => a + Math.max(0, b), 0);
}
