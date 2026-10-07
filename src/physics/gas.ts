import type { GasSpecies } from '../types';

/**
 * Gas properties used by the conductance correlations.
 *
 * Molecular long-tube conductance is proportional to sqrt(T/M), normalized
 * to the requested reference: air at 20 °C, d=2.5 cm, L=100 cm gives
 * 1.89 L/s.
 */
interface GasProperty {
  molarMass: number;
  /** Sutherland viscosity parameters: eta(T) in Pa*s. */
  viscosityRef: number;
  sutherlandT: number;
  sutherlandS: number;
}

const GASES: Record<GasSpecies, GasProperty> = {
  // Sutherland constants: eta_ref at T_ref (K), S in K.
  air: { molarMass: 28.9647, viscosityRef: 1.8205e-5, sutherlandT: 293.15, sutherlandS: 120.0 },
  N2: { molarMass: 28.0134, viscosityRef: 1.781e-5, sutherlandT: 300.55, sutherlandS: 111.0 },
  O2: { molarMass: 31.9988, viscosityRef: 2.055e-5, sutherlandT: 300.65, sutherlandS: 127.0 },
  Ar: { molarMass: 39.948, viscosityRef: 2.270e-5, sutherlandT: 300.15, sutherlandS: 144.0 },
  He: { molarMass: 4.0026, viscosityRef: 1.985e-5, sutherlandT: 300.15, sutherlandS: 79.4 },
  H2: { molarMass: 2.01588, viscosityRef: 8.90e-6, sutherlandT: 300.15, sutherlandS: 72.0 },
  CO2: { molarMass: 44.0095, viscosityRef: 1.502e-5, sutherlandT: 300.15, sutherlandS: 240.0 }
};

const AIR = GASES.air;

export const DEFAULT_TEMPERATURE = 293.15;

export function gasProperty(species: GasSpecies): GasProperty {
  return GASES[species]!;
}

/** Dynamic viscosity in Pa*s using a Sutherland correlation. */
export function viscosity(species: GasSpecies, temperature: number): number {
  const g = gasProperty(species);
  return (
    g.viscosityRef *
    Math.pow(temperature / g.sutherlandT, 1.5) *
    ((g.sutherlandT + g.sutherlandS) / (temperature + g.sutherlandS))
  );
}

/**
 * Molecular-flow long circular-tube conductance in L/s.
 *
 * Generalized from the 20 °C air reference by sqrt(T/M). The long-tube
 * approximation ignores end/aperture corrections.
 */
export function molecularConductance(
  diameterCm: number,
  lengthCm: number,
  species: GasSpecies,
  temperature: number
): number {
  const reference = 1.89;
  const g = GASES[species]!;
  const factor =
    Math.sqrt(temperature / DEFAULT_TEMPERATURE) *
    Math.sqrt(AIR.molarMass / g.molarMass);
  return (
    reference *
    factor *
    Math.pow(diameterCm / 2.5, 3) *
    (100 / lengthCm)
  );
}

/**
 * Viscous (Poiseuille) conductance C = pi*d^4/(128*eta*L) * average pressure
 * in L/s for d,L in cm, pressure in mbar. The factor 0.1 converts
 * Pa*m^3/s per Pa to L/s per mbar with the corresponding geometric units.
 */
export function viscousConductanceCoefficient(
  diameterCm: number,
  lengthCm: number,
  species: GasSpecies,
  temperature: number
): number {
  const eta = viscosity(species, temperature);
  return (0.1 * Math.PI * Math.pow(diameterCm, 4)) / (128 * eta * lengthCm);
}
