import type { PumpEdgeInput } from '../types';

/**
 * Pump model:
 *  - speed S(p) is a piecewise-linear function of inlet pressure built from
 *    the user supplied table; values outside the table are clamped to the
 *    nearest end point (flat extrapolation).
 *  - the pump operates only when inlet pressure <= startPressureMbar
 *    (crossover / start-up pressure). Above it the pump is disconnected
 *    (speed zero), which models the staged switch-in of Roots / turbo pumps.
 */
export class PumpModel {
  readonly id: string;
  readonly node: string;
  readonly startPressureMbar: number;
  private readonly pressures: number[];
  private readonly speeds: number[];

  constructor(edge: PumpEdgeInput) {
    this.id = edge.id;
    this.node = edge.node;
    this.startPressureMbar = edge.startPressureMbar;
    this.pressures = edge.speedTable.map((pt) => pt.pressureMbar);
    this.speeds = edge.speedTable.map((pt) => pt.speedLps);
  }

  isActive(inletPressureMbar: number): boolean {
    return inletPressureMbar <= this.startPressureMbar;
  }

  /** Pumping speed at the given inlet pressure, ignoring the start gate. */
  speedAt(inletPressureMbar: number): number {
    const p = inletPressureMbar;
    const ps = this.pressures;
    const ss = this.speeds;
    if (ps.length === 1) return ss[0];
    if (p <= ps[0]) return ss[0];
    if (p >= ps[ps.length - 1]) return ss[ss.length - 1];
    // Binary search for the enclosing interval.
    let lo = 0;
    let hi = ps.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ps[mid] <= p) lo = mid;
      else hi = mid;
    }
    const f = (p - ps[lo]) / (ps[hi] - ps[lo]);
    return ss[lo] + f * (ss[hi] - ss[lo]);
  }

  /**
   * Effective speed after the start gate and its pressure derivative.
   * Returns { speed, dSpeed/dP }.
   */
  effectiveAt(inletPressureMbar: number): { speed: number; active: boolean; dSpeed: number } {
    if (!this.isActive(inletPressureMbar)) return { speed: 0, active: false, dSpeed: 0 };
    const p = inletPressureMbar;
    const ps = this.pressures;
    const ss = this.speeds;
    if (ps.length === 1) return { speed: ss[0], active: true, dSpeed: 0 };
    if (p <= ps[0]) return { speed: ss[0], active: true, dSpeed: 0 };
    if (p >= ps[ps.length - 1]) return { speed: ss[ss.length - 1], active: true, dSpeed: 0 };
    let lo = 0;
    let hi = ps.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ps[mid] <= p) lo = mid;
      else hi = mid;
    }
    const dSpeed = (ss[hi] - ss[lo]) / (ps[hi] - ps[lo]);
    const f = (p - ps[lo]) / (ps[hi] - ps[lo]);
    return { speed: ss[lo] + f * (ss[hi] - ss[lo]), active: true, dSpeed };
  }

  /**
   * Gate factor g(p) for the *numerical* solve path:
   *   p ≤ pstart−δ     -> 1 (fully on)
   *   p ≥ pstart       -> 0 (off)
   *   narrow band      -> smooth quadratic ramp
   * δ = max(1e-4·pstart, 1e-12 mbar). The physical switch instant (p = pstart)
   * is still detected by the strict isActive() gate during event scanning, so
   * reported crossover times are unaffected; the ramp only removes the
   * discontinuity that otherwise stalls Newton's line search exactly at the
   * crossover on junction networks.
   */
  gateFactor(inletPressureMbar: number): { g: number; dg: number } {
    const pStart = this.startPressureMbar;
    const delta = Math.max(1e-4 * pStart, 1e-12);
    const pLo = pStart - delta;
    if (inletPressureMbar <= pLo) return { g: 1, dg: 0 };
    if (inletPressureMbar >= pStart) return { g: 0, dg: 0 };
    // s in (0,1): g = 1 - s^2 (continuous value and derivative at both ends).
    const s = (inletPressureMbar - pLo) / delta;
    return { g: 1 - s * s, dg: (-2 * s) / delta };
  }
}
