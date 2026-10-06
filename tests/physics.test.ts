import { describe, expect, it } from 'vitest';
import {
  parallelConductance,
  pipeConductanceAtMeanPressure,
  pipeMolecularConductanceLps,
  pipeViscousConductanceLps,
  seriesConductance
} from '../src/physics/conductance';
import { dynamicViscosity, meanFreePath, meanMolecularSpeed } from '../src/physics/gas';
import { PumpModel } from '../src/physics/pump';

describe('gas properties', () => {
  it('mean molecular speed of air at 20 C is about 463 m/s', () => {
    const v = meanMolecularSpeed('air', 293.15);
    expect(v).toBeGreaterThan(460);
    expect(v).toBeLessThan(466);
  });

  it('viscosity of air at 20 C is about 1.81e-5 Pa s', () => {
    const eta = dynamicViscosity('air', 293.15);
    expect(eta).toBeGreaterThan(1.7e-5);
    expect(eta).toBeLessThan(1.9e-5);
  });

  it('mean free path of air at 1013 mbar is about 68 nm', () => {
    const lambda = meanFreePath('air', 293.15, 1013);
    expect(lambda).toBeGreaterThan(5e-8);
    expect(lambda).toBeLessThan(9e-8);
  });
});

describe('pipe conductance - reference value', () => {
  it('d=25 mm, L=1 m circular tube in molecular flow: ~1.89 L/s for 20 C air', () => {
    const c = pipeMolecularConductanceLps(0.025, 1, 'air', 293.15);
    expect(c).toBeCloseTo(1.89, 2);
  });

  it('scales with d^3/L in molecular flow', () => {
    const base = pipeMolecularConductanceLps(0.025, 1, 'air', 293.15);
    const wider = pipeMolecularConductanceLps(0.05, 1, 'air', 293.15);
    expect(wider / base).toBeCloseTo(8, 6);
    const longer = pipeMolecularConductanceLps(0.025, 2, 'air', 293.15);
    expect(longer / base).toBeCloseTo(0.5, 6);
  });

  it('viscous conductance scales linearly with mean pressure and d^4', () => {
    const a = pipeViscousConductanceLps(0.025, 1, 'air', 293.15, 100);
    const b = pipeViscousConductanceLps(0.025, 1, 'air', 293.15, 200);
    expect(b / a).toBeCloseTo(2, 8);
    const wide = pipeViscousConductanceLps(0.05, 1, 'air', 293.15, 100);
    expect(wide / a).toBeCloseTo(16, 8);
  });

  it('reports molecular regime at low pressure and viscous regime at high pressure', () => {
    const low = pipeConductanceAtMeanPressure(0.025, 1, 'air', 293.15, 1e-6);
    const high = pipeConductanceAtMeanPressure(0.025, 1, 'air', 293.15, 1000);
    expect(low.regime).toBe('molecular');
    expect(high.regime).toBe('viscous');
    expect(low.viscousLps / low.molecularLps).toBeLessThan(1e-3);
    expect(high.viscousLps).toBeGreaterThan(high.molecularLps * 1e3);
  });
});

describe('conductance combination rules', () => {
  it('series conductance is no larger than any single element', () => {
    const parts = [1.89, 3.0, 5.5];
    const c = seriesConductance(parts);
    for (const p of parts) expect(c).toBeLessThanOrEqual(p);
    // explicit: 1/(1/1.89 + 1/3 + 1/5.5)
    const expected = 1 / (1 / 1.89 + 1 / 3 + 1 / 5.5);
    expect(c).toBeCloseTo(expected, 10);
  });

  it('parallel conductance is the sum and never decreases', () => {
    const c1 = 1.89;
    const c2 = 3.2;
    expect(parallelConductance([c1, c2])).toBeCloseTo(c1 + c2, 10);
    expect(parallelConductance([c1, c2])).toBeGreaterThanOrEqual(c1);
    expect(parallelConductance([c1, c2, 0])).toBeCloseTo(c1 + c2, 10);
  });

  it('series with a closed (zero) element is zero', () => {
    expect(seriesConductance([1.89, 0, 4])).toBe(0);
  });
});

describe('pump model', () => {
  it('linearly interpolates the speed table and clamps outside it', () => {
    const pump = new PumpModel({
      id: 'p',
      kind: 'pump',
      node: 'n',
      startPressureMbar: 10,
      speedTable: [
        { pressureMbar: 0, speedLps: 50 },
        { pressureMbar: 1, speedLps: 40 },
        { pressureMbar: 10, speedLps: 10 }
      ]
    });
    expect(pump.speedAt(0)).toBe(50);
    expect(pump.speedAt(0.5)).toBe(45);
    expect(pump.speedAt(20)).toBe(10);
    expect(pump.isActive(10)).toBe(true);
    expect(pump.isActive(10.0001)).toBe(false);
    expect(pump.effectiveAt(11).speed).toBe(0);
    expect(pump.effectiveAt(0.5).speed).toBe(45);
    expect(pump.effectiveAt(0.5).dSpeed).toBeCloseTo(-10, 10);
  });
});
