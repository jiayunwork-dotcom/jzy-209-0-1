import type { Outgassing } from '../types';

export function outgassingAt(spec: Outgassing | undefined, time: number): number {
  if (!spec) return 0;
  if (spec.kind === 'constant') return spec.rate;
  if (spec.kind === 'exponential') {
    return Math.max(0, spec.rate0 * Math.exp(-time / spec.tau));
  }
  // Power-law: q(t)=q0*(t0/t)^alpha for t>t0. At and before t0 it is q0.
  const t0 = spec.t0 ?? 3600;
  if (time <= t0) return spec.rate0;
  return spec.rate0 * Math.pow(t0 / time, spec.alpha);
}

export function outgassingAtSteady(spec: Outgassing | undefined): number {
  if (!spec) return 0;
  // Steady-state ultimate pressure uses the long-time limiting rate.
  if (spec.kind === 'constant') return spec.rate;
  return 0;
}
