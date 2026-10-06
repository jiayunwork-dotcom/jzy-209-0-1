import { describe, expect, it } from 'vitest';
import { outgassingAt, steadyOutgassing } from '../src/physics/outgassing';
import { runPumpdown } from '../src/compute/pumpdown';
import { executeJob } from '../src/compute/runner';
import { MemoryStore } from '../src/storage/memory';
import { JobScheduler } from '../src/jobs/scheduler';
import type { JobRequest, SystemVersionInput } from '../src/types';

const T = 293.15;

describe('outgassing decay models', () => {
  it('constant model is time independent', () => {
    const m = { type: 'constant', q: 3 } as const;
    expect(outgassingAt(m, 0)).toBe(3);
    expect(outgassingAt(m, 1e9)).toBe(3);
    expect(steadyOutgassing(m)).toBe(3);
  });

  it('power law decays from the 100 s reference and reaches zero at steady state', () => {
    const m = { type: 'power', q100: 2, alpha: 1 } as const;
    expect(outgassingAt(m, 100)).toBeCloseTo(2, 12);
    expect(outgassingAt(m, 400)).toBeCloseTo(0.5, 12);
    expect(steadyOutgassing(m)).toBe(0);
  });

  it('exponential decays from q0 to qInf, and steady state is qInf', () => {
    const m = { type: 'exponential', q0: 10, qInf: 1, tau: 5 } as const;
    expect(outgassingAt(m, 0)).toBeCloseTo(10, 12);
    expect(outgassingAt(m, 5)).toBeCloseTo(1 + 9 / Math.E, 10);
    expect(steadyOutgassing(m)).toBe(1);
  });

  it('rational decays as 1/(1+t/tau)', () => {
    const m = { type: 'rational', q0: 8, tau: 2 } as const;
    expect(outgassingAt(m, 0)).toBe(8);
    expect(outgassingAt(m, 6)).toBeCloseTo(2, 12);
    expect(steadyOutgassing(m)).toBe(0);
  });
});

describe('pump-down limiting pressure with constant outgassing', () => {
  it('asymptotically approaches the steady balance pressure q/S_eff', async () => {
    const v: SystemVersionInput = {
      gas: 'air',
      temperatureK: T,
      nodes: [{ id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 1e-5 } }],
      edges: [
        {
          id: 'pump', kind: 'pump', node: 'C', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    };
    const version = await new MemoryStore().createVersion({ input: v });
    const res = await runPumpdown(version, {
      initialPressureMbar: 1,
      maxTimeS: 5000,
      relTol: 1e-9
    });
    expect(res.convergence.stopReason).toBe('time_limit');
    // pInf = q/S = 1e-6 mbar; after 5000 s the transient from 1 mbar is gone.
    expect(res.finalPressuresMbar['C']).toBeCloseTo(1e-6, 8);
  });
});

describe('hot start through the runner (scheduler path)', () => {
  it('a hot-started steady job and a cold job on the same version agree within tolerance', async () => {
    const store = new MemoryStore();
    const scheduler = new JobScheduler(store);
    const input: SystemVersionInput = {
      gas: 'air',
      temperatureK: T,
      nodes: [
        { id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 5e-7 } },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        {
          id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    };
    const version = await store.createVersion({ input });

    // Build a "previous version" result first.
    const prevVersion = await store.createVersion({
      systemId: version.systemId,
      input: {
        ...input,
        edges: [
          { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 30, lengthM: 1 },
          input.edges[1]
        ]
      }
    });
    const prevSub = await scheduler.submit(prevVersion, { kind: 'steady', versionId: prevVersion.versionId });
    const prev = await store.getJob(prevSub.job.jobId);
    await new Promise((r) => setTimeout(r, 20));
    const prevDone = await store.getJob(prev!.jobId);
    expect(prevDone?.status).toBe('completed');

    const coldReq: JobRequest = { kind: 'steady', versionId: version.versionId };
    const coldResult = await executeJob(version, coldReq, store, { token: { cancelled: false } });
    const hotResult = await executeJob(
      version,
      { ...coldReq, hotStartFromJobId: prevDone!.jobId },
      store,
      { token: { cancelled: false } }
    );
    expect(coldResult.kind).toBe('steady');
    expect(hotResult.kind).toBe('steady');
    if (coldResult.kind === 'steady' && hotResult.kind === 'steady') {
      for (const id of ['C', 'J']) {
        const a = coldResult.pressuresMbar[id];
        const b = hotResult.pressuresMbar[id];
        expect(Math.abs(b - a) / a).toBeLessThan(1e-7);
      }
      expect(hotResult.convergence.converged).toBe(true);
    }
    await store.close();
  });

  it('node-id mapping ignores deleted nodes and fills added nodes with cold start', async () => {
    const store = new MemoryStore();
    const mkInput = (withC2: boolean): SystemVersionInput => ({
      gas: 'air',
      temperatureK: T,
      nodes: [
        { id: 'C1', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 1e-7 } },
        ...(withC2 ? ([{ id: 'C2', kind: 'chamber', volumeL: 50, outgassing: { type: 'constant', q: 1e-7 } }] as const) : []),
        { id: 'gone', kind: 'chamber', volumeL: 20, outgassing: { type: 'constant', q: 1e-7 } },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        { id: 'p1', kind: 'pipe', from: 'C1', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        ...(withC2
          ? ([{ id: 'p2', kind: 'pipe', from: 'C2', to: 'J', innerDiameterMm: 25, lengthM: 1 }] as const)
          : ([{ id: 'pgone', kind: 'pipe', from: 'gone', to: 'J', innerDiameterMm: 25, lengthM: 1 }] as const)),
        {
          id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }]
        }
      ]
    });
    const oldV = await store.createVersion({ input: mkInput(false) });
    const newV = await store.createVersion({ systemId: oldV.systemId, input: mkInput(true) });
    const oldRes = await executeJob(oldV, { kind: 'steady', versionId: oldV.versionId }, store, {
      token: { cancelled: false }
    });
    expect(oldRes.kind).toBe('steady');

    // Simulate the runner mapping directly: ids C1/J transfer, "gone" is
    // dropped, C2 must fall back to cold start.
    const map = oldRes.kind === 'steady' ? oldRes.pressuresMbar : {};
    expect(map['gone']).toBeGreaterThan(0);
    expect(map['C2']).toBeUndefined();

    const newCold = await executeJob(newV, { kind: 'steady', versionId: newV.versionId }, store, {
      token: { cancelled: false }
    });
    const newHot = await executeJob(
      newV,
      { kind: 'steady', versionId: newV.versionId, initialPressures: map } as JobRequest,
      store,
      { token: { cancelled: false } }
    );
    if (newCold.kind === 'steady' && newHot.kind === 'steady') {
      for (const id of ['C1', 'C2', 'J']) {
        expect(Math.abs(newHot.pressuresMbar[id] - newCold.pressuresMbar[id]) / newCold.pressuresMbar[id]).toBeLessThan(1e-7);
      }
    }
    await store.close();
  });
});
