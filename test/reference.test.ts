import { describe, it, expect } from 'vitest';
import { molecularConductance, viscousConductanceCoefficient } from '../src/physics/gas';
import {
  createTubeModel,
  parallelConductance,
  seriesConductance,
  tubeConductance
} from '../src/physics/conductance';
import { runSteadyCalculation, runTransientCalculation } from '../src/service/calculation';
import type { VacuumSystem } from '../src/types';

const constantPump = (speed: number, from = 'chamber') => ({
  id: 'pump',
  kind: 'pump' as const,
  from,
  curve: [
    { pressure: 0, speed },
    { pressure: 2000, speed }
  ]
});

describe('conductance reference model', () => {
  it('matches 20 C air molecular long-tube conductance 1.89 L/s', () => {
    const c = molecularConductance(2.5, 100, 'air', 293.15);
    expect(c).toBeCloseTo(1.89, 2);
  });

  it('gives effective pump speed S*C/(S+C) close to 1.59 L/s', () => {
    const c = molecularConductance(2.5, 100, 'air', 293.15);
    const effective = (10 * c) / (10 + c);
    expect(effective).toBeCloseTo(1.59, 2);
  });

  it('reproduces the 1.59 L/s effective speed as a network steady state', () => {
    const q = 1e-6; // mbar*L/s, molecular regime
    const system: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: q } },
        { id: 'inlet', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
        constantPump(10, 'inlet')
      ]
    };
    const result = runSteadyCalculation(system, { initialPressure: 1e-5 });
    expect(result.converged).toBe(true);
    const pc = result.pressures.find((p) => p.nodeId === 'chamber')!.pressure;
    const pi = result.pressures.find((p) => p.nodeId === 'inlet')!.pressure;
    const effective = q / pc;
    expect(effective).toBeCloseTo(1.59, 2);
    // Junction pressure is q/S; chamber pressure q/S_eff.
    expect(pi).toBeCloseTo(q / 10, 6);
  });

  it('uses pressure-independent molecular flow and linear viscous flow', () => {
    const model = createTubeModel(2.5, 100, 'air', 293.15);
    expect(tubeConductance(model, 0)).toBeCloseTo(1.89, 6);
    const k = viscousConductanceCoefficient(2.5, 100, 'air', 293.15);
    expect(tubeConductance(model, 10)).toBeCloseTo(model.molecular + k * 10, 8);
    expect(k).toBeGreaterThan(0);
  });
});

describe('series and parallel conductance relations', () => {
  it('series is no larger than either segment; parallel is no smaller', () => {
    const a = tubeConductance(createTubeModel(2.5, 100, 'air', 293.15), 1);
    const b = tubeConductance(createTubeModel(5, 200, 'air', 293.15), 1);
    const series = seriesConductance([a, b]);
    expect(series).toBeLessThanOrEqual(a + 1e-12);
    expect(series).toBeLessThanOrEqual(b + 1e-12);
    const parallel = parallelConductance([a, b]);
    expect(parallel).toBeGreaterThanOrEqual(a - 1e-12);
    expect(parallel).toBeGreaterThanOrEqual(b - 1e-12);
  });

  it('network: splitting a run into two series pipes cannot increase conductance', () => {
    const q = 1e-3; // pressure sits around transition/molecular
    const direct: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: q } },
        { id: 'inlet', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
        constantPump(100, 'inlet')
      ]
    };
    const split: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: q } },
        { id: 'mid', kind: 'junction' },
        { id: 'inlet', kind: 'junction' }
      ],
      edges: [
        { id: 'p1', kind: 'pipe', a: 'chamber', b: 'mid', diameter: 2.5, length: 50 },
        { id: 'p2', kind: 'pipe', a: 'mid', b: 'inlet', diameter: 2.5, length: 50 },
        constantPump(100, 'inlet')
      ]
    };
    const pd = runSteadyCalculation(direct, { initialPressure: 1e-3 });
    const ps = runSteadyCalculation(split, { initialPressure: 1e-3 });
    const pressureDirect = pd.pressures.find((x) => x.nodeId === 'chamber')!.pressure;
    const pressureSplit = ps.pressures.find((x) => x.nodeId === 'chamber')!.pressure;
    expect(pressureSplit).toBeGreaterThanOrEqual(pressureDirect - 1e-12);
  });

  it('network: adding a parallel pipe cannot reduce conductance', () => {
    const q = 1e-3;
    const one: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: q } },
        { id: 'inlet', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe1', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
        constantPump(100, 'inlet')
      ]
    };
    const two: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: q } },
        { id: 'inlet', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe1', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
        { id: 'pipe2', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
        constantPump(100, 'inlet')
      ]
    };
    const p1 = runSteadyCalculation(one, { initialPressure: 1e-3 });
    const p2 = runSteadyCalculation(two, { initialPressure: 1e-3 });
    const pressureOne = p1.pressures.find((x) => x.nodeId === 'chamber')!.pressure;
    const pressureTwo = p2.pressures.find((x) => x.nodeId === 'chamber')!.pressure;
    expect(pressureTwo).toBeLessThanOrEqual(pressureOne + 1e-12);
  });
});

describe('pumpdown reference', () => {
  it('evacuates 100 L from 1000 mbar to 1 mbar at constant 10 L/s in about 69.1 s', () => {
    const system: VacuumSystem = {
      nodes: [{ id: 'chamber', kind: 'chamber', volume: 100 }],
      edges: [constantPump(10)]
    };
    const result = runTransientCalculation(system, {
      initialPressure: 1000,
      targetPressure: 1,
      maxTime: 1000,
      initialStep: 0.01,
      maxStep: 0.5
    });
    expect(result.stopReason).toBe('targets-reached');
    expect(result.targetArrivals[0]!.time).toBeCloseTo(69.07755, 1);
  });
});

describe('steady physical identities', () => {
  const build = (outgassing: number): VacuumSystem => ({
    nodes: [
      { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: outgassing } },
      { id: 'inlet', kind: 'junction' }
    ],
    edges: [
      { id: 'pipe', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
      {
        id: 'pump',
        kind: 'pump',
        from: 'inlet',
        curve: [
          { pressure: 0, speed: 10 },
          { pressure: 1000, speed: 10 }
        ]
      }
    ]
  });

  it('doubles ultimate pressure when all molecular-flow outgassing doubles', () => {
    const one = runSteadyCalculation(build(1e-6), { initialPressure: 1e-5 });
    const two = runSteadyCalculation(build(2e-6), { initialPressure: 1e-5 });
    const p1 = one.pressures.find((x) => x.nodeId === 'chamber')!.pressure;
    const p2 = two.pressures.find((x) => x.nodeId === 'chamber')!.pressure;
    expect(p1).toBeGreaterThan(0);
    expect(p2 / p1).toBeCloseTo(2, 3);
  });
});
