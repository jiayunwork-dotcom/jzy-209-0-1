import type { GasSpecies } from '../types';

/**
 * Gas properties used by the conductance and viscosity correlations.
 *
 *  molarMassKgMol      kg/mol
 *  sutherlandMu0 Pa·s  reference dynamic viscosity
 *  sutherlandT0  K     reference temperature
 *  sutherlandC   K     Sutherland constant
 *  molecularDiameterM  hard-sphere diameter (mean free path)
 */
interface GasProps {
  molarMassKgMol: number;
  sutherlandMu0: number;
  sutherlandT0: number;
  sutherlandC: number;
  molecularDiameterM: number;
}

const GAS_TABLE: Record<GasSpecies, GasProps> = {
  // Sutherland constants from standard tables; diameters from kinetic theory.
  air: { molarMassKgMol: 0.02897, sutherlandMu0: 1.716e-5, sutherlandT0: 273.15, sutherlandC: 110.4, molecularDiameterM: 3.72e-10 },
  N2: { molarMassKgMol: 0.0280134, sutherlandMu0: 1.663e-5, sutherlandT0: 273.15, sutherlandC: 107.0, molecularDiameterM: 3.7e-10 },
  O2: { molarMassKgMol: 0.0319988, sutherlandMu0: 1.919e-5, sutherlandT0: 273.15, sutherlandC: 139.0, molecularDiameterM: 3.46e-10 },
  H2: { molarMassKgMol: 0.00201588, sutherlandMu0: 8.411e-6, sutherlandT0: 273.15, sutherlandC: 62.3, molecularDiameterM: 2.89e-10 },
  He: { molarMassKgMol: 0.0040026, sutherlandMu0: 1.865e-5, sutherlandT0: 273.15, sutherlandC: 79.4, molecularDiameterM: 2.6e-10 },
  Ar: { molarMassKgMol: 0.039948, sutherlandMu0: 2.117e-5, sutherlandT0: 273.15, sutherlandC: 155.0, molecularDiameterM: 3.66e-10 },
  Ne: { molarMassKgMol: 0.0201797, sutherlandMu0: 2.977e-5, sutherlandT0: 273.15, sutherlandC: 79.0, molecularDiameterM: 2.75e-10 },
  CO2: { molarMassKgMol: 0.0440095, sutherlandMu0: 1.370e-5, sutherlandT0: 273.15, sutherlandC: 222.0, molecularDiameterM: 4.6e-10 },
  // water vapour: Sutherland correlation is approximate.
  water_vapor: { molarMassKgMol: 0.01801528, sutherlandMu0: 0.926e-5, sutherlandT0: 273.15, sutherlandC: 506.0, molecularDiameterM: 4.6e-10 }
};

export const R_GAS = 8.314462618; // J/(mol K)
export const P_ATM_PA = 101325;
/** 1 mbar expressed in pascal. */
export const MBAR_TO_PA = 100;

export function getGasProps(species: GasSpecies): GasProps {
  const props = GAS_TABLE[species];
  if (!props) throw new Error(`unknown gas species: ${species}`);
  return props;
}

/** Mean molecular speed vbar = sqrt(8 R T / (pi M)), m/s. */
export function meanMolecularSpeed(species: GasSpecies, temperatureK: number): number {
  const p = getGasProps(species);
  return Math.sqrt((8 * R_GAS * temperatureK) / (Math.PI * p.molarMassKgMol));
}

/** Dynamic viscosity via the Sutherland correlation, Pa s. */
export function dynamicViscosity(species: GasSpecies, temperatureK: number): number {
  const p = getGasProps(species);
  const ratio = temperatureK / p.sutherlandT0;
  return p.sutherlandMu0 * ratio * Math.sqrt(ratio) * ((p.sutherlandT0 + p.sutherlandC) / (temperatureK + p.sutherlandC));
}

/**
 * Hard-sphere mean free path at a given pressure:
 *   lambda = k T / (sqrt(2) pi d^2 p)
 * pressure is in mbar.
 */
export function meanFreePath(species: GasSpecies, temperatureK: number, pressureMbar: number): number {
  const p = getGasProps(species);
  const pressurePa = pressureMbar * MBAR_TO_PA;
  const k = 1.380649e-23;
  return (k * temperatureK) / (Math.SQRT2 * Math.PI * p.molecularDiameterM * p.molecularDiameterM * pressurePa);
}
