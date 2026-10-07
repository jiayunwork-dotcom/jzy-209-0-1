import { describe, it, expect } from 'vitest';
import { runSteadyCalculation, runTransientCalculation } from '../src/service/calculation';
import { prepareNetwork } from '../src/solver/network';
import { evaluateSteady } from '../src/solver/steady';
import type { VacuumSystem } from '../src/types';

const speed = (s: number) => [
  { pressure: 0, speed: s },
  { pressure: 2000, speed: s }
];

describe('network mass balance', () => {
  it('leaves algebraic residual near zero at every node of a branched network', () => {
    const system: VacuumSystem = {
      nodes: [
        { id: 'c1', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: 2e-5 } },
        { id: 'c2', kind: 'chamber', volume: 50, outgassing: { kind: 'constant', rate: 1e-5 } },
        { id: 'j', kind: 'junction' }
      ],
      edges: [
        { id: 'p1', kind: 'pipe', a: 'c1', b: 'j', diameter: 2.5, length: 100 },
        { id: 'p2', kind: 'pipe', a: 'c2', b: 'j', diameter: 4, length: 200 },
        { id: 'pump', kind: 'pump', from: 'j', curve: speed(50) }
      ]
    };
    const result = runSteadyCalculation(system, { initialPressure: 1e-4 });
    expect(result.converged).toBe(true);
    const network = prepareNetwork(system);
    const p = network.groups.map((group) => {
      return result.pressures.find((x) => group.memberIds.includes(x.nodeId))!.pressure;
    });
    const ev = evaluateSteady(network, p, network.pumps.map(() => true));
    for (const residual of ev.residual) expect(Math.abs(residual)).toBeLessThan(1e-10);
  });
});

describe('pump startup interlocks', () => {
  it('latches a high-vacuum pump only after its start pressure is crossed', () => {
    const system: VacuumSystem = {
      nodes: [{ id: 'chamber', kind: 'chamber', volume: 100 }],
      edges: [
        { id: 'backing', kind: 'pump', from: 'chamber', curve: speed(5) },
        { id: 'booster', kind: 'pump', from: 'chamber', curve: speed(50), startPressure: 100 }
      ]
    };
    const result = runTransientCalculation(system, {
      initialPressure: 1000,
      targetPressure: 1,
      maxTime: 1000,
      initialStep: 0.01,
      maxStep: 1
    });
    expect(result.stopReason).toBe('targets-reached');
    const switchEvent = result.pumpSwitches.find((event) => event.pumpId === 'booster');
    expect(switchEvent).toBeTruthy();
    expect(switchEvent!.inletPressure).toBeLessThanOrEqual(100 * (1 + 1e-3));
    expect(switchEvent!.time).toBeGreaterThan(0);
    expect(result.activePumpsAtEnd).toContain('backing');
    expect(result.activePumpsAtEnd).toContain('booster');
  });

  it('rejects a run in which no pump is allowed at the initial pressure', () => {
    const system: VacuumSystem = {
      nodes: [{ id: 'chamber', kind: 'chamber', volume: 100 }],
      edges: [{ id: 'pump', kind: 'pump', from: 'chamber', curve: speed(10), startPressure: 10 }]
    };
    expect(() =>
      runTransientCalculation(system, { initialPressure: 1000, targetPressure: 1 })
    ).toThrow(/no pump/);
  });
});

describe('non-convergence reporting', () => {
  it('returns pressures and residual for a transient step solver that cannot converge', () => {
    // An extremely tight nonlinear tolerance with one Newton iteration cannot
    // normally be met; the run must still return a result with honest flags.
    const system: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100 },
        { id: 'inlet', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
        { id: 'pump', kind: 'pump', from: 'inlet', curve: speed(10) }
      ]
    };
    const result = runTransientCalculation(system, {
      initialPressure: 1000,
      targetPressure: 1,
      maxTime: 1000,
      initialStep: 100,
      minStep: 50,
      maxStep: 100,
      maxIterations: 1,
      residualTolerance: 1e-14
    });
    expect(result.stopReason).toBe('solver-failure');
    expect(result.converged).toBe(false);
    expect(Number.isFinite(result.finalResidual)).toBe(true);
    expect(result.finalPressures.length).toBeGreaterThan(0);
  });
});
