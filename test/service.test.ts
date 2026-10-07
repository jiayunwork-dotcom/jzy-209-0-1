import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import type { VacuumSystem } from '../src/types';
import { runSteadyCalculation } from '../src/service/calculation';
import type { CreatedApp } from '../src/app';

const pumpCurve = [
  { pressure: 0, speed: 10 },
  { pressure: 2000, speed: 10 }
];

const baseSystem: VacuumSystem = {
  nodes: [
    { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: 1e-6 } },
    { id: 'inlet', kind: 'junction' }
  ],
  edges: [
    { id: 'pipe', kind: 'pipe', a: 'chamber', b: 'inlet', diameter: 2.5, length: 100 },
    { id: 'pump', kind: 'pump', from: 'inlet', curve: pumpCurve }
  ]
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(
  service: CreatedApp['service'],
  jobId: string,
  timeoutMs = 10000
): Promise<Awaited<ReturnType<CreatedApp['service']['getJob']>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await service.getJob(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await wait(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe('job service', () => {
  let created: CreatedApp;

  beforeEach(() => {
    created = createApp({ autoStartScheduler: true, pollIntervalMs: 5 });
  });

  it('truthfully reports non-convergence when iteration cap is hit', () => {
    // A one-iteration budget cannot solve even a tiny network from a far guess.
    const result = runSteadyCalculation(baseSystem, {
      initialPressure: 1000,
      maxIterations: 1,
      residualTolerance: 1e-12
    });
    expect(result.converged).toBe(false);
    expect(result.iterations).toBeGreaterThanOrEqual(result.maxIterations);
    expect(Number.isFinite(result.finalResidual)).toBe(true);
    expect(result.finalResidual).toBeGreaterThan(result.residualTolerance);
    // Current pressures are still returned; never a fabricated converged flag.
    expect(result.pressures).toHaveLength(2);
  });

  it('submits jobs, exposes progress and cancels a queued or running job', async () => {
    const version = await created.service.createVersion(baseSystem);
    const job = await created.service.submitJob({
      versionId: version.id,
      kind: 'transient',
      params: {
        initialPressure: 1000,
        targetPressure: 1e-6,
        maxTime: 1e6,
        initialStep: 0.01,
        maxStep: 10
      }
    });

    let cancelled = false;
    // Cancellation may win either while queued or while running; both are valid
    // terminal states and must not be reported as successful convergence.
    for (let i = 0; i < 100; i++) {
      const current = await created.service.getJob(job.id);
      if (current.status === 'succeeded') break;
      const after = await created.service.cancelJob(job.id);
      if (after.status === 'cancelled') {
        cancelled = true;
        break;
      }
      await wait(2);
    }
    const final = await created.service.getJob(job.id);
    if (!cancelled) {
      expect(['succeeded', 'cancelled']).toContain(final.status);
    } else {
      expect(final.status).toBe('cancelled');
    }
  });

  it('compares versions and flags chambers whose ultimate pressure changes beyond threshold', async () => {
    const v1 = await created.service.createVersion(baseSystem);
    const changed: VacuumSystem = {
      ...baseSystem,
      nodes: [
        { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: 4e-6 } },
        { id: 'inlet', kind: 'junction' }
      ]
    };
    const v2 = await created.service.createVersion(changed, v1.id);
    const comparison = await created.service.compareVersions({
      fromVersionId: v1.id,
      toVersionId: v2.id,
      kind: 'steady',
      threshold: 0.5,
      params: { initialPressure: 1e-5 }
    });
    expect(comparison.status).toBe('ready');
    const chamber = comparison.exceeds.find((x) => x.nodeId === 'chamber');
    expect(chamber).toBeTruthy();
    expect(chamber!.relativeChange).toBeGreaterThan(0.5);
  });

  it('hot-start and cold-start steady results agree within convergence tolerance', async () => {
    const v1 = await created.service.createVersion(baseSystem);
    const coldJob = await created.service.submitJob({
      versionId: v1.id,
      kind: 'steady',
      params: { initialPressure: 1000, residualTolerance: 1e-9 }
    });
    const cold = await waitForStatus(created.service, coldJob.id);

    const modifiedSystem: VacuumSystem = {
      ...baseSystem,
      nodes: [
        ...baseSystem.nodes,
        { id: 'added-junction', kind: 'junction' }
      ]
    };
    const v2 = await created.service.createVersion(modifiedSystem, v1.id);
    const hotJob = await created.service.submitJob({
      versionId: v2.id,
      kind: 'steady',
      params: { initialPressure: 1000, residualTolerance: 1e-9 },
      hotStartFromJobId: coldJob.id
    });
    const hot = await waitForStatus(created.service, hotJob.id);

    expect(cold.status).toBe('succeeded');
    expect(hot.status).toBe('succeeded');
    const coldP = Object.fromEntries(
      cold.result!.pressures.map((x) => [x.nodeId, x.pressure])
    );
    for (const point of hot.result!.pressures) {
      if (point.nodeId === 'added-junction') continue;
      const reference = coldP[point.nodeId]!;
      expect(Math.abs(point.pressure - reference) / Math.max(reference, 1e-30)).toBeLessThan(
        1e-7
      );
    }
    expect(hot.result!.converged).toBe(true);
  });

  it('reuses the existing job for identical version and parameters', async () => {
    const version = await created.service.createVersion(baseSystem);
    const params = { initialPressure: 1000, residualTolerance: 1e-8 };
    const first = await created.service.submitJob({
      versionId: version.id,
      kind: 'steady',
      params
    });
    const firstDone = await waitForStatus(created.service, first.id);
    const second = await created.service.submitJob({
      versionId: version.id,
      kind: 'steady',
      params
    });
    expect(second.id).toBe(firstDone.id);
  });
});
