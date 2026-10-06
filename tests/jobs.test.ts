import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import type { Store } from '../src/storage/store';
import { JobScheduler } from '../src/jobs/scheduler';
import { compareVersions } from '../src/versioning/compare';
import { runSteady } from '../src/compute/steady';
import { runPumpdown } from '../src/compute/pumpdown';
import type { JobRequest, SystemVersionInput } from '../src/types';

const T = 293.15;

function layout(variant: 'base' | 'wider' | 'extra'): SystemVersionInput {
  const extra = variant === 'extra';
  return {
    gas: 'air',
    temperatureK: T,
    nodes: [
      { id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 1e-7 } },
      ...(extra ? ([{ id: 'C2', kind: 'chamber', volumeL: 40 }] as const) : []),
      { id: 'J', kind: 'junction' }
    ],
    edges: [
      {
        id: 'pipe', kind: 'pipe', from: 'C', to: 'J',
        innerDiameterMm: variant === 'wider' ? 40 : 25,
        lengthM: 1
      },
      ...(extra
        ? ([{ id: 'pipe2', kind: 'pipe', from: 'C2', to: 'J', innerDiameterMm: 25, lengthM: 1 }] as const)
        : []),
      {
        id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
        speedTable: [{ pressureMbar: 0, speedLps: 10 }]
      }
    ]
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(store: Store, jobId: string, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const job = await store.getJob(jobId);
    if (!job) throw new Error('job missing');
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${jobId} (${job.status})`);
    await wait(5);
  }
}

describe('job lifecycle', () => {
  let store: Store;
  let scheduler: JobScheduler;

  beforeEach(() => {
    store = new MemoryStore();
    scheduler = new JobScheduler(store);
  });
  afterEach(async () => {
    await store.close();
  });

  it('submits a steady job, runs it, and reports convergence + residual', async () => {
    const version = await store.createVersion({ input: layout('base') });
    const req: JobRequest = { kind: 'steady', versionId: version.versionId };
    const { job, reused } = await scheduler.submit(version, req);
    expect(reused).toBe(false);
    expect(job.status).toBe('queued');
    const done = await waitFor(store, job.jobId);
    expect(done.status).toBe('completed');
    expect(done.result?.kind).toBe('steady');
    if (done.result?.kind === 'steady') {
      expect(done.result.convergence.converged).toBe(true);
      expect(done.result.convergence.finalResidual).toBeLessThan(1e-9);
      expect(done.result.limitingPressureMbar['C']).toBeGreaterThan(0);
    }
    expect(done.versionFingerprint).toBe(version.fingerprint);
  });

  it('reuses the result for an identical submission instead of recomputing', async () => {
    const version = await store.createVersion({ input: layout('base') });
    const req: JobRequest = {
      kind: 'pumpdown',
      versionId: version.versionId,
      initialPressureMbar: 100,
      target: { pressureMbar: 1 },
      relTol: 1e-7
    };
    const a = await scheduler.submit(version, req);
    const done = await waitFor(store, a.job.jobId);
    expect(done.status).toBe('completed');

    const b = await scheduler.submit(version, JSON.parse(JSON.stringify(req)));
    expect(b.reused).toBe(true);
    expect(b.job.jobId).toBe(a.job.jobId);

    // Even a request submitted while the previous one is still queued reuses.
    const v2 = await store.createVersion({ input: layout('wider') });
    const req2: JobRequest = { kind: 'steady', versionId: v2.versionId };
    const c1 = await scheduler.submit(v2, req2);
    const c2 = await scheduler.submit(v2, { ...req2 });
    expect(c1.job.jobId).toBe(c2.job.jobId);
    expect(c2.reused).toBe(true);
    await waitFor(store, c1.job.jobId);
  });

  it('cancels a queued job before it starts', async () => {
    const versions: string[] = [];
    // Occupy the single worker with a long pump-down so the second job queues.
    const busyVer = await store.createVersion({
      input: {
        gas: 'air',
        temperatureK: T,
        nodes: [
          { id: 'C', kind: 'chamber', volumeL: 1000 },
          { id: 'J', kind: 'junction' }
        ],
        edges: [
          { id: 'p', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 10, lengthM: 5 },
          {
            id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
            speedTable: [{ pressureMbar: 0, speedLps: 1 }]
          }
        ]
      }
    });
    versions.push(busyVer.versionId);
    const busy = await scheduler.submit(busyVer, {
      kind: 'pumpdown',
      versionId: busyVer.versionId,
      initialPressureMbar: 1000,
      target: { pressureMbar: 1e-6 },
      maxStepS: 0.5
    });
    const queuedVer = await store.createVersion({ input: layout('base') });
    versions.push(queuedVer.versionId);
    const queued = await scheduler.submit(queuedVer, {
      kind: 'steady',
      versionId: queuedVer.versionId
    });
    await wait(10);
    expect((await store.getJob(queued.job.jobId))?.status).toBe('queued');
    const cancelled = await scheduler.cancel(queued.job.jobId);
    expect(cancelled?.status).toBe('cancelled');
    // Clean up the blocking job too.
    await scheduler.cancel(busy.job.jobId);
    await wait(100);
  });

  it('cancels a running job; the job stops and is marked cancelled', async () => {
    // Large volume, small pump, tiny max step => many outer steps; the running
    // loop observes the cancel token between steps.
    const version = await store.createVersion({
      input: {
        gas: 'air',
        temperatureK: T,
        nodes: [
          { id: 'C', kind: 'chamber', volumeL: 10000 },
          { id: 'J', kind: 'junction' }
        ],
        edges: [
          { id: 'p', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 8, lengthM: 10 },
          {
            id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
            speedTable: [{ pressureMbar: 0, speedLps: 0.5 }]
          }
        ]
      }
    });
    const submitted = await scheduler.submit(version, {
      kind: 'pumpdown',
      versionId: version.versionId,
      initialPressureMbar: 1000,
      target: { pressureMbar: 1e-9 },
      maxTimeS: 1e6,
      maxStepS: 0.01
    });
    await wait(30);
    let running = await store.getJob(submitted.job.jobId);
    expect(running?.status).toBe('running');
    await scheduler.cancel(submitted.job.jobId);
    const done = await waitFor(store, submitted.job.jobId);
    expect(done.status).toBe('cancelled');
  }, 30000);
});

describe('hot start vs cold start agreement', () => {
  it('steady: hot start from the previous version result matches a cold start within tolerance', async () => {
    const store = new MemoryStore();
    const scheduler = new JobScheduler(store);
    const v1 = await store.createVersion({ input: layout('base') });
    const v2 = await store.createVersion({ systemId: v1.systemId, input: layout('wider') });
    expect(v2.version).toBe(2);

    const coldReq: JobRequest = { kind: 'steady', versionId: v2.versionId };
    const coldSub = await scheduler.submit(v2, coldReq);
    const cold = await waitFor(store, coldSub.job.jobId);

    const firstSub = await scheduler.submit(v1, { kind: 'steady', versionId: v1.versionId });
    const firstJob = await waitFor(store, firstSub.job.jobId);

    // Hot start is accepted as a distinct job (its request differs) but its
    // physical answer must equal the cold answer within solver tolerance.
    const hotSub = await scheduler.submit(v2, {
      ...coldReq,
      hotStartFromJobId: firstJob.jobId
    });
    void hotSub;
    const coldResult = cold.result!;
    const hotResult = await runSteady(v2, {
      initialPressures:
        firstJob.result?.kind === 'steady' ? firstJob.result.pressuresMbar : undefined
    });
    expect(hotResult.convergence.converged).toBe(true);
    if (coldResult.kind === 'steady') {
      const pCold = coldResult.pressuresMbar['C'];
      const pHot = hotResult.pressuresMbar['C'];
      expect(Math.abs(pHot - pCold) / pCold).toBeLessThan(1e-7);
      expect(Math.abs(hotResult.convergence.finalResidual)).toBeLessThan(1e-9);
    }
    await store.close();
  });

  it('pump-down target time is the same whether or not a previous solution seeds the initial guess', async () => {
    const v = await new MemoryStore().createVersion({ input: layout('base') });
    const common = {
      initialPressureMbar: 500,
      target: { pressureMbar: 1e-4 },
      relTol: 1e-9,
      absTol: 1e-13
    };
    const cold = await runPumpdown(v, common);
    // Hot start seeds only junction guesses; chambers start at initialPressure.
    const hot = await runPumpdown(v, {
      ...common,
      initialPressures: { J: 300 }
    });
    expect(cold.targetTimeS).not.toBeNull();
    expect(Math.abs((hot.targetTimeS ?? 0) - (cold.targetTimeS ?? 0))).toBeLessThan(1e-4);
  });
});

describe('version comparison', () => {
  it('flags chambers whose limiting pressure moves beyond the threshold, and lists added/removed', async () => {
    const store = new MemoryStore();
    const scheduler = new JobScheduler(store);
    const v1 = await store.createVersion({ input: layout('base') });
    const v2 = await store.createVersion({ systemId: v1.systemId, input: layout('wider') });
    const v3 = await store.createVersion({ systemId: v1.systemId, input: layout('extra') });

    const report2 = await compareVersions(
      store,
      async (versionId, req) => scheduler.submit((await store.getVersion(versionId))!, req),
      v1.versionId,
      v2.versionId,
      { kind: 'steady', ratioThreshold: 0.05 }
    );
    expect(report2.oldJobId).not.toBe(report2.newJobId);
    const cEntry = report2.entries.find((e) => e.chamberId === 'C')!;
    expect(cEntry.changed).toBe(true); // wider pipe lowers limiting pressure
    expect(report2.changedChambers).toContain('C');
    expect(cEntry.relativeChange).toBeGreaterThan(0.05);

    // v3 adds chamber C2.
    const report3 = await compareVersions(
      store,
      async (versionId, req) => scheduler.submit((await store.getVersion(versionId))!, req),
      v1.versionId,
      v3.versionId,
      { kind: 'steady', ratioThreshold: 0.5 }
    );
    expect(report3.addedChambers).toEqual(['C2']);
    expect(report3.removedChambers).toEqual([]);

    await store.close();
  });

  it('compares pump-down target times between versions', async () => {
    const store = new MemoryStore();
    const scheduler = new JobScheduler(store);
    const v1 = await store.createVersion({ input: layout('base') });
    const v2 = await store.createVersion({ systemId: v1.systemId, input: layout('wider') });
    const report = await compareVersions(
      store,
      async (versionId, req) => scheduler.submit((await store.getVersion(versionId))!, req),
      v1.versionId,
      v2.versionId,
      {
        kind: 'pumpdown',
        ratioThreshold: 0.01,
        initialPressureMbar: 100,
        target: { pressureMbar: 1 }
      }
    );
    const entry = report.entries.find((e) => e.chamberId === 'C')!;
    expect(entry.metric).toBe('targetTimeS');
    expect(entry.oldValue).not.toBeNull();
    expect(entry.newValue).not.toBeNull();
    // Wider conductance reaches the target sooner.
    expect(entry.newValue!).toBeLessThan(entry.oldValue!);
    await store.close();
  });
});
