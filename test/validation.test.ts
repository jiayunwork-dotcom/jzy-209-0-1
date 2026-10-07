import { describe, it, expect } from 'vitest';
import { validateSystem, validateTransientParams } from '../src/physics/validation';
import { ValidationError } from '../src/errors';
import type { VacuumSystem } from '../src/types';

const goodSystem: VacuumSystem = {
  nodes: [{ id: 'chamber', kind: 'chamber', volume: 100 }],
  edges: [
    {
      id: 'pump',
      kind: 'pump',
      from: 'chamber',
      curve: [
        { pressure: 0, speed: 10 },
        { pressure: 1000, speed: 10 }
      ]
    }
  ]
};

describe('input validation and rejection', () => {
  it('rejects non-positive chamber volume', () => {
    const issues = validateSystem({
      ...goodSystem,
      nodes: [{ id: 'chamber', kind: 'chamber', volume: 0 }]
    });
    expect(issues.join(' ')).toMatch(/volume must be a finite positive number/);
  });

  it('rejects non-positive pipe diameter and length', () => {
    const system: VacuumSystem = {
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100 },
        { id: 'j', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe', kind: 'pipe', a: 'chamber', b: 'j', diameter: -1, length: 0 },
        ...goodSystem.edges.map((e) => (e.kind === 'pump' ? { ...e, from: 'j' } : e))
      ]
    };
    const issues = validateSystem(system);
    expect(issues.some((x) => x.includes('diameter'))).toBe(true);
    expect(issues.some((x) => x.includes('length'))).toBe(true);
  });

  it('rejects negative outgassing', () => {
    const issues = validateSystem({
      ...goodSystem,
      nodes: [
        {
          id: 'chamber',
          kind: 'chamber',
          volume: 100,
          outgassing: { kind: 'constant', rate: -0.1 }
        }
      ]
    });
    expect(issues[0]).toMatch(/non-negative/);
  });

  it('rejects non-monotonic and negative pump curve points', () => {
    const issues = validateSystem({
      ...goodSystem,
      edges: [
        {
          id: 'pump',
          kind: 'pump',
          from: 'chamber',
          curve: [
            { pressure: 10, speed: 10 },
            { pressure: 5, speed: -1 }
          ]
        }
      ]
    });
    expect(issues.some((x) => x.includes('strictly increasing'))).toBe(true);
    expect(issues.some((x) => x.includes('speed'))).toBe(true);
  });

  it('names chambers that have no path to any pump', () => {
    const system: VacuumSystem = {
      nodes: [
        { id: 'pumped', kind: 'chamber', volume: 100 },
        { id: 'orphan-a', kind: 'chamber', volume: 50 },
        { id: 'orphan-b', kind: 'chamber', volume: 20 }
      ],
      edges: [
        {
          id: 'pump',
          kind: 'pump',
          from: 'pumped',
          curve: [
            { pressure: 0, speed: 10 },
            { pressure: 1000, speed: 10 }
          ]
        }
      ]
    };
    const issues = validateSystem(system);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('orphan-a');
    expect(issues[0]).toContain('orphan-b');
    expect(() => {
      if (issues.length) throw new ValidationError(issues);
    }).toThrow(ValidationError);
  });

  it('rejects target pressure not below initial pressure', () => {
    const issues = validateTransientParams(goodSystem, {
      initialPressure: 1,
      targetPressure: 1
    });
    expect(issues.some((x: string) => x.includes('targetPressure must be lower'))).toBe(true);
  });
});
