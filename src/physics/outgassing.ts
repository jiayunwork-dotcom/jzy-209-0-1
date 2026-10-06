import type { OutgassingModel } from '../types';

/**
 * Time dependent surface outgassing q(t) in mbar L/s.
 *
 *   constant:    q
 *   power:       q100 * (t/100s)^(-alpha)   (common vacuum bake-out law;
 *                t is clamped to >= 1 s so that q is never infinite)
 *   exponential: qInf + (q0 - qInf) e^{-t/tau}
 *   rational:    q0 / (1 + t/tau)
 *
 * The steady-state limiting value is q(Infinity): constant -> q, power -> 0,
 * exponential -> qInf, rational -> 0.
 */
export function outgassingAt(model: OutgassingModel | undefined, timeS: number): number {
  if (!model) return 0;
  switch (model.type) {
    case 'constant':
      return model.q;
    case 'power': {
      const t = Math.max(timeS, 1);
      return model.q100 * Math.pow(t / 100, -model.alpha);
    }
    case 'exponential':
      return model.qInf + (model.q0 - model.qInf) * Math.exp(-timeS / model.tau);
    case 'rational':
      return model.q0 / (1 + timeS / model.tau);
  }
}

export function steadyOutgassing(model: OutgassingModel | undefined): number {
  if (!model) return 0;
  switch (model.type) {
    case 'constant':
      return model.q;
    case 'power':
      return 0;
    case 'exponential':
      return model.qInf;
    case 'rational':
      return 0;
  }
}
