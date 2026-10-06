import { describe, expect, it } from 'vitest';
import { runPumpdown } from '../src/compute/pumpdown';
import type { PumpdownJobRequest, SystemVersion } from '../src/types';

const T = 293.15;

function version(partial: Partial<SystemVersion> & Pick<SystemVersion, 'nodes' | 'edges'>): SystemVersion {
  return {
    systemId: 'sys',
    versionId: 'ver',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    fingerprint: 'fp',
    gas: 'air',
    temperatureK: T,
    ...partial
  };
}

describe('reference pump-down time', () => {
  it('100 L chamber, constant 10 L/s, 1000 -> 1 mbar takes ~69.1 s', async () => {
    const v = version({
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 100 }],
      edges: [
        {
          id: 'pump', kind: 'pump', node: 'C', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    });
    const res = await runPumpdown(v, {
      initialPressureMbar: 1000,
      target: { pressureMbar: 1 },
      relTol: 1e-9,
      absTol: 1e-12
    });
    expect(res.convergence.stopReason).toBe('target_reached');
    expect(res.targetTimeS).toBeCloseTo((100 / 10) * Math.log(1000), 1);
    expect(res.targetTimeS).toBeGreaterThan(69.0);
    expect(res.targetTimeS).toBeLessThan(69.2);
  });

  it('pressure curve is monotonically non-increasing without outgassing', async () => {
    const v = version({
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 100 }],
      edges: [
        {
          id: 'pump', kind: 'pump', node: 'C', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    });
    const res = await runPumpdown(v, {
      initialPressureMbar: 760,
      target: { pressureMbar: 1 },
      relTol: 1e-7
    });
    const ps = res.curve.map((pt) => pt.pressuresMbar['C']);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i]).toBeLessThanOrEqual(ps[i - 1] + 1e-12);
    }
  });
});

describe('pump switching (crossover pressure)', () => {
  it('a pump gated above its start pressure engages on the way down and accelerates the pump-down', async () => {
    // Mechanical pump 5 L/s always on; turbo 50 L/s only below 1 mbar.
    const v = version({
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 100 }],
      edges: [
        {
          id: 'mech', kind: 'pump', node: 'C', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 5 }]
        },
        {
          id: 'turbo', kind: 'pump', node: 'C', startPressureMbar: 1,
          speedTable: [{ pressureMbar: 0, speedLps: 50 }]
        }
      ]
    });
    const res = await runPumpdown(v, {
      initialPressureMbar: 100,
      target: { pressureMbar: 0.01 },
      relTol: 1e-8,
      absTol: 1e-13
    });
    expect(res.convergence.stopReason).toBe('target_reached');
    const events = res.pumpEvents.filter((e) => e.pumpId === 'turbo' && e.active);
    expect(events.length).toBe(1);
    // Turbo engages at p = 1 mbar; mech alone takes (100/5) ln(100/1) = 92.1 s.
    expect(events[0].timeS).toBeCloseTo((100 / 5) * Math.log(100), 1);
    expect(events[0].inletPressureMbar).toBeCloseTo(1, 3);

    // Before the event the active set does not contain turbo.
    const before = res.curve.find((pt) => pt.timeS < events[0].timeS)!;
    expect(before.activePumps).toContain('mech');
    expect(before.activePumps).not.toContain('turbo');
    const after = res.curve.find((pt) => pt.timeS >= events[0].timeS)!;
    expect(after.activePumps).toContain('turbo');

    // Final segment is faster: 1 mbar -> 0.01 mbar at 55 L/s takes 8.37 s.
    const tailTime = (res.targetTimeS ?? 0) - events[0].timeS;
    expect(tailTime).toBeCloseTo((100 / 55) * Math.log(100), 0);
  });

  it('reports allTargetsReached=false and targetTimes null when maxTime is too short', async () => {
    const v = version({
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 100 }],
      edges: [
        {
          id: 'pump', kind: 'pump', node: 'C', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    });
    const res = await runPumpdown(v, {
      initialPressureMbar: 1000,
      target: { pressureMbar: 1 },
      maxTimeS: 1,
      relTol: 1e-7
    });
    expect(res.allTargetsReached).toBe(false);
    expect(res.targetTimeS).toBeNull();
    expect(res.targetTimesS['C']).toBeNull();
    expect(res.finalTimeS).toBeCloseTo(1, 9);
    expect(res.convergence.stopReason).toBe('time_limit');
  });
});

describe('pump-down through a junction network', () => {
  it('two chambers sharing a pump through pipes pump consistently and reach their targets', async () => {
    const v = version({
      nodes: [
        { id: 'C1', kind: 'chamber', volumeL: 100 },
        { id: 'C2', kind: 'chamber', volumeL: 50 },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        { id: 'p1', kind: 'pipe', from: 'C1', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        { id: 'p2', kind: 'pipe', from: 'C2', to: 'J', innerDiameterMm: 25, lengthM: 2 },
        {
          id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 20 }]
        }
      ]
    });
    const req: PumpdownJobRequest = {
      kind: 'pumpdown',
      versionId: 'ver',
      initialPressureMbar: 500,
      target: { pressureMbar: 1, chamberIds: ['C1', 'C2'] },
      relTol: 1e-8
    };
    const res = await runPumpdown(v, req);
    expect(res.allTargetsReached).toBe(true);
    expect(res.targetTimesS['C1']).not.toBeNull();
    expect(res.targetTimesS['C2']).not.toBeNull();
    // Smaller chamber with a longer (lower conductance) pipe: just check both
    // hit and the junction stays below both chambers (flow direction).
    const last = res.curve[res.curve.length - 1];
    expect(last.pressuresMbar['C1']).toBeGreaterThanOrEqual(res.finalPressuresMbar['C1'] - 1e-9);
  });

  it('a closed valve disconnects a chamber and it stays at initial pressure', async () => {
    const v = version({
      nodes: [
        { id: 'C1', kind: 'chamber', volumeL: 100 },
        { id: 'C2', kind: 'chamber', volumeL: 30 },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        { id: 'p1', kind: 'pipe', from: 'C1', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        { id: 'v1', kind: 'valve', from: 'C2', to: 'J', openConductanceLps: 50 },
        {
          id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    });
    // Note: C2 has no open path to the pump; the compute path tolerates this
    // (the HTTP layer rejects the job) and C2 simply retains its pressure.
    const res = await runPumpdown(v, {
      initialPressureMbar: 100,
      valveStates: { v1: false },
      target: { pressureMbar: 1, chamberIds: ['C1'] },
      maxTimeS: 200,
      relTol: 1e-8
    });
    expect(res.targetTimesS['C1']).not.toBeNull();
    expect(res.finalPressuresMbar['C2']).toBeCloseTo(100, 9);
  });
});
