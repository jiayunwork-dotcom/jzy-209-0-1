import { describe, it, expect, beforeEach } from 'vitest';
import { createApp, type CreatedApp } from '../src/app';
import type { VacuumSystem } from '../src/types';

const curve = [
  { pressure: 0, speed: 10 },
  { pressure: 2000, speed: 10 }
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(service: CreatedApp['service'], id: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await service.getJob(id);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await wait(5);
  }
  throw new Error(`job ${id} did not finish`);
}

describe('transient version comparison', () => {
  let app: CreatedApp;

  beforeEach(() => {
    app = createApp({ autoStartScheduler: true, pollIntervalMs: 5 });
  });

  it('detects pump-down time changes and lists added and removed chambers', async () => {
    const v1System: VacuumSystem = {
      nodes: [{ id: 'c1', kind: 'chamber', volume: 100 }],
      edges: [{ id: 'pump', kind: 'pump', from: 'c1', curve }]
    };
    const v2System: VacuumSystem = {
      nodes: [
        { id: 'c1', kind: 'chamber', volume: 200 },
        { id: 'c2', kind: 'chamber', volume: 50 }
      ],
      edges: [
        { id: 'pump', kind: 'pump', from: 'c1', curve },
        { id: 'valve', kind: 'valve', a: 'c1', b: 'c2', defaultOpen: true }
      ]
    };
    const v3System: VacuumSystem = {
      nodes: [{ id: 'c1', kind: 'chamber', volume: 200 }],
      edges: [{ id: 'pump', kind: 'pump', from: 'c1', curve }]
    };

    const v1 = await app.service.createVersion(v1System);
    const v2 = await app.service.createVersion(v2System, v1.id);
    const v3 = await app.service.createVersion(v3System, v2.id);

    const comparison12 = await app.service.compareVersions({
      fromVersionId: v1.id,
      toVersionId: v2.id,
      kind: 'transient',
      threshold: 0.2,
      params: {
        initialPressure: 1000,
        targetPressure: 1,
        maxTime: 1000,
        initialStep: 0.1,
        maxStep: 5
      }
    });
    expect(comparison12.status).toBe('ready');
    expect(comparison12.changed.some((x) => x.nodeId === 'c1')).toBe(true);
    expect(comparison12.addedNodes).toEqual(['c2']);

    const comparison23 = await app.service.compareVersions({
      fromVersionId: v2.id,
      toVersionId: v3.id,
      kind: 'transient',
      threshold: 0.1,
      params: {
        initialPressure: 1000,
        targetPressure: 1,
        maxTime: 1000,
        initialStep: 0.1,
        maxStep: 5
      }
    });
    expect(comparison23.status).toBe('ready');
    expect(comparison23.removedNodes).toEqual(['c2']);
  });
});
