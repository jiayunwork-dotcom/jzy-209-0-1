/**
 * Pump model.
 *
 * A pump is represented by speed values S(p) at tabulated inlet pressures.
 * Linear interpolation is used between points, and values are clamped to the
 * endpoint speeds outside the supplied range. The curve is validated to have
 * non-negative pressures and speeds and strictly increasing pressure points.
 */
export interface PumpCurvePoint {
  pressure: number;
  speed: number;
}

export interface PumpModel {
  points: PumpCurvePoint[];
  startPressure: number;
}

export function createPumpModel(points: PumpCurvePoint[], startPressure?: number): PumpModel {
  return {
    points: points.map((p) => ({ pressure: p.pressure, speed: p.speed })),
    startPressure: startPressure ?? Number.POSITIVE_INFINITY
  };
}

/** Pumping speed in L/s at inlet pressure, with endpoint clamping. */
export function pumpSpeed(model: PumpModel, pressure: number): number {
  const pts = model.points;
  if (pts.length === 0) return 0;
  if (pressure <= pts[0]!.pressure) return pts[0]!.speed;
  const last = pts[pts.length - 1]!;
  if (pressure >= last.pressure) return last.speed;

  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i]!;
    const hi = pts[i + 1]!;
    if (pressure >= lo.pressure && pressure <= hi.pressure) {
      const w = (pressure - lo.pressure) / (hi.pressure - lo.pressure);
      return lo.speed + w * (hi.speed - lo.speed);
    }
  }
  return last.speed;
}

/**
 * Throughput Q = S(p)*p in mbar*L/s removed from the inlet node.
 * The function is piecewise linear in p, so the derivative is well defined
 * inside each interval.
 */
export function pumpThroughput(model: PumpModel, pressure: number): number {
  return pumpSpeed(model, pressure) * pressure;
}

/** d(S(p)p)/dp at tabulation-interval interior. Endpoints use one-sided slopes. */
export function pumpThroughputDerivative(model: PumpModel, pressure: number): number {
  const pts = model.points;
  if (pts.length === 0) return 0;
  if (pressure <= pts[0]!.pressure) {
    // Q = S0*p
    return pts[0]!.speed;
  }
  const last = pts[pts.length - 1]!;
  if (pressure >= last.pressure) {
    return last.speed;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i]!;
    const hi = pts[i + 1]!;
    if (pressure >= lo.pressure && pressure <= hi.pressure) {
      const ds = (hi.speed - lo.speed) / (hi.pressure - lo.pressure);
      const s = lo.speed + ds * (pressure - lo.pressure);
      return s + ds * pressure;
    }
  }
  return last.speed;
}

export function pumpCanStart(model: PumpModel, inletPressure: number): boolean {
  return inletPressure <= model.startPressure;
}
