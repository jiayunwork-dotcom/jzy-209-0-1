import { describe, expect, it } from 'vitest';
import { chambersWithoutPumpPath, validateJob, validateSystem } from '../src/validation/validate';
import type { JobRequest, SystemVersionInput } from '../src/types';

const base: SystemVersionInput = {
  gas: 'air',
  temperatureK: 293.15,
  nodes: [
    { id: 'C1', kind: 'chamber', volumeL: 100 },
    { id: 'C2', kind: 'chamber', volumeL: 50 },
    { id: 'J', kind: 'junction' }
  ],
  edges: [
    { id: 'p1', kind: 'pipe', from: 'C1', to: 'J', innerDiameterMm: 25, lengthM: 1 },
    { id: 'v1', kind: 'valve', from: 'C2', to: 'J', openConductanceLps: 40 },
    {
      id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 10,
      speedTable: [{ pressureMbar: 0, speedLps: 10 }]
    }
  ]
};

describe('system description validation', () => {
  it('accepts the baseline description', () => {
    expect(validateSystem(base)).toEqual([]);
  });

  it('rejects non-positive volume', () => {
    const issues = validateSystem({
      ...base,
      nodes: [{ id: 'C1', kind: 'chamber', volumeL: 0 }],
      edges: []
    });
    expect(issues.some((m) => m.includes('volumeL must be a positive number'))).toBe(true);
  });

  it('rejects negative volume and diameter/length', () => {
    const issues = validateSystem({
      gas: 'air',
      temperatureK: 293.15,
      nodes: [{ id: 'C', kind: 'chamber', volumeL: -3 }],
      edges: [
        { id: 'p', kind: 'pipe', from: 'C', to: 'X', innerDiameterMm: -10, lengthM: 0 }
      ]
    });
    expect(issues.join(' ')).toMatch(/volumeL/);
    expect(issues.join(' ')).toMatch(/innerDiameterMm/);
    expect(issues.join(' ')).toMatch(/lengthM/);
  });

  it('rejects negative outgassing for every model', () => {
    const models = [
      { type: 'constant', q: -1 },
      { type: 'power', q100: -1, alpha: 1 },
      { type: 'exponential', q0: -1, qInf: 0, tau: 10 },
      { type: 'rational', q0: -1, tau: 10 }
    ];
    for (const outgassing of models) {
      const issues = validateSystem({
        gas: 'air',
        temperatureK: 293.15,
        nodes: [{ id: 'C', kind: 'chamber', volumeL: 10, outgassing: outgassing as never }],
        edges: []
      });
      expect(issues.join(' ')).toMatch(/outgassing|q0|q100|qInf|q must/);
    }
  });

  it('rejects non-monotonic and negative pressure points in the pump curve', () => {
    const issues = validateSystem({
      gas: 'air',
      temperatureK: 293.15,
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 10 }],
      edges: [
        {
          id: 'pump', kind: 'pump', node: 'C', startPressureMbar: 1,
          speedTable: [
            { pressureMbar: 1, speedLps: 5 },
            { pressureMbar: 1, speedLps: 5 },
            { pressureMbar: -2, speedLps: 5 }
          ]
        }
      ]
    });
    const joined = issues.join(' ');
    expect(joined).toMatch(/strictly increasing/);
    expect(joined).toMatch(/non-negative/);
  });

  it('rejects negative pump speed and negative start pressure', () => {
    const issues = validateSystem({
      gas: 'air',
      temperatureK: 293.15,
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 10 }],
      edges: [
        {
          id: 'pump', kind: 'pump', node: 'C', startPressureMbar: -1,
          speedTable: [
            { pressureMbar: 0, speedLps: -5 },
            { pressureMbar: 1, speedLps: 4 }
          ]
        }
      ]
    });
    expect(issues.join(' ')).toMatch(/speedLps must be non-negative/);
    expect(issues.join(' ')).toMatch(/startPressureMbar/);
  });

  it('rejects duplicate node/edge ids and unknown references', () => {
    const issues = validateSystem({
      gas: 'air',
      temperatureK: 293.15,
      nodes: [
        { id: 'C', kind: 'chamber', volumeL: 10 },
        { id: 'C', kind: 'junction' }
      ],
      edges: [
        { id: 'x', kind: 'pipe', from: 'C', to: 'ZZ', innerDiameterMm: 25, lengthM: 1 },
        { id: 'x', kind: 'pump', node: 'C', startPressureMbar: 1,
          speedTable: [{ pressureMbar: 0, speedLps: 2 }] }
      ]
    });
    const joined = issues.join(' ');
    expect(joined).toMatch(/duplicate node id: C/);
    expect(joined).toMatch(/duplicate edge id: x/);
    expect(joined).toMatch(/unknown endpoint node ZZ/);
  });

  it('rejects bad temperature and unknown gas', () => {
    const issues = validateSystem({ ...base, gas: 'Xe' as never, temperatureK: -1 });
    expect(issues.join(' ')).toMatch(/gas/);
    expect(issues.join(' ')).toMatch(/temperatureK/);
  });
});

describe('connectivity check', () => {
  it('names every chamber with no path to a pump', () => {
    const sys: SystemVersionInput = {
      gas: 'air',
      temperatureK: 293.15,
      nodes: [
        { id: 'A', kind: 'chamber', volumeL: 10 },
        { id: 'B', kind: 'chamber', volumeL: 20 },
        { id: 'C', kind: 'chamber', volumeL: 30 },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        { id: 'pa', kind: 'pipe', from: 'A', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        { id: 'vb', kind: 'valve', from: 'B', to: 'J' },
        // C is completely isolated
        {
          id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1,
          speedTable: [{ pressureMbar: 0, speedLps: 5 }]
        }
      ]
    };
    // C is completely isolated by design; only A and B (with the valve open) connect.
    expect(chambersWithoutPumpPath(sys)).toEqual(['C']);
    expect(chambersWithoutPumpPath(sys, { vb: false }).sort()).toEqual(['B', 'C']);
  });
});

describe('job request validation', () => {
  const pumpReq: JobRequest = {
    kind: 'pumpdown',
    versionId: 'v',
    initialPressureMbar: 100
  };

  it('rejects target pressure >= initial pressure', () => {
    const issues = validateJob(base, { ...pumpReq, target: { pressureMbar: 100 } });
    expect(issues.join(' ')).toMatch(/target pressure must be strictly below initial/);
    const issues2 = validateJob(base, { ...pumpReq, target: { pressureMbar: 500 } });
    expect(issues2.join(' ')).toMatch(/strictly below initial/);
  });

  it('rejects non-positive initial pressure', () => {
    const issues = validateJob(base, { ...pumpReq, initialPressureMbar: 0 });
    expect(issues.join(' ')).toMatch(/initialPressureMbar/);
  });

  it('rejects chambers disconnected by closed valves, naming them', () => {
    const issues = validateJob(base, {
      kind: 'steady',
      versionId: 'v',
      valveStates: { v1: false }
    });
    expect(issues.join(' ')).toMatch(/without any open path to a pump: C2/);
  });

  it('rejects unknown valve references', () => {
    const issues = validateJob(base, {
      kind: 'steady',
      versionId: 'v',
      valveStates: { ghost: true }
    });
    expect(issues.join(' ')).toMatch(/unknown valve: ghost/);
  });

  it('accepts a valid pump-down request', () => {
    const issues = validateJob(base, {
      ...pumpReq,
      target: { pressureMbar: 1 },
      valveStates: { v1: true }
    });
    expect(issues).toEqual([]);
  });
});
