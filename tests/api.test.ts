import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app';
import type { AppDeps } from '../src/http/app';
import type { SystemVersionInput } from '../src/types';

const layout: SystemVersionInput = {
  gas: 'air',
  temperatureK: 293.15,
  nodes: [
    { id: 'C', kind: 'chamber', volumeL: 100 },
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

describe('HTTP API', () => {
  let app: FastifyInstance;
  let deps: AppDeps;

  beforeAll(async () => {
    const built = await buildApp();
    app = built.app;
    deps = built.deps;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await deps.store.close();
  });

  it('health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('creates a system and rejects invalid descriptions with the full issue list', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/systems',
      payload: {
        gas: 'air',
        temperatureK: 293.15,
        nodes: [{ id: 'C', kind: 'chamber', volumeL: -5 }],
        edges: [
          { id: 'p', kind: 'pipe', from: 'C', to: 'X', innerDiameterMm: 0, lengthM: -1 },
          {
            id: 'pump', kind: 'pump', node: 'C', startPressureMbar: 1,
            speedTable: [
              { pressureMbar: 10, speedLps: -1 },
              { pressureMbar: 1, speedLps: 5 }
            ]
          }
        ]
      }
    });
    expect(bad.statusCode).toBe(400);
    const body = bad.json();
    expect(body.error).toBe('validation_error');
    const joined: string = body.issues.join(' ');
    expect(joined).toMatch(/volumeL/);
    expect(joined).toMatch(/innerDiameterMm/);
    expect(joined).toMatch(/lengthM/);
    expect(joined).toMatch(/unknown endpoint node X/);
    expect(joined).toMatch(/strictly increasing/);
    expect(joined).toMatch(/speedLps/);

    const ok = await app.inject({ method: 'POST', url: '/systems', payload: layout });
    expect(ok.statusCode).toBe(201);
    const v = ok.json();
    expect(v.versionId).toBeTruthy();
    expect(v.version).toBe(1);
    expect(v.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('appends a second version and lists versions', async () => {
    const first = await app.inject({ method: 'POST', url: '/systems', payload: layout });
    const systemId = first.json().systemId;
    const second = await app.inject({
      method: 'POST',
      url: `/systems/${systemId}/versions`,
      payload: {
        ...layout,
        edges: [
          { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 40, lengthM: 1 },
          layout.edges[1]
        ]
      }
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().version).toBe(2);
    const list = await app.inject({ method: 'GET', url: `/systems/${systemId}/versions` });
    expect(list.json().versions).toHaveLength(2);
  });

  it('submits a pump-down job, polls it, and returns the bound version fingerprint', async () => {
    const v = (await app.inject({ method: 'POST', url: '/systems', payload: layout })).json();
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        kind: 'pumpdown',
        versionId: v.versionId,
        initialPressureMbar: 1000,
        target: { pressureMbar: 1 },
        relTol: 1e-8
      }
    });
    expect(submit.statusCode).toBe(202);
    const { jobId } = submit.json();

    let status = 'queued';
    let body: { status: string; result?: { targetTimeS?: number | null }; versionFingerprint?: string } = { status: 'queued' };
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/jobs/${jobId}` });
      body = res.json();
      status = body.status;
      if (status === 'completed' || status === 'failed') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(status).toBe('completed');
    // 100 L at an effective speed ~1.59 L/s through the tube over 3 decades:
    // V/S_eff * ln(1000); at high pressure the viscous conductance is huge so
    // most of the run sees nearly the full 10 L/s. Allow the tube-influenced
    // band; the exact 69.1 reference is covered by the direct-pump unit tests.
    expect(body!.result!.targetTimeS).toBeGreaterThan(69);
    expect(body!.result!.targetTimeS).toBeLessThan(73);
    expect(body.versionFingerprint).toBe(v.fingerprint);
  });

  it('rejects target >= initial and disconnected chambers', async () => {
    const v = (await app.inject({ method: 'POST', url: '/systems', payload: layout })).json();
    const res = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        kind: 'pumpdown',
        versionId: v.versionId,
        initialPressureMbar: 100,
        target: { pressureMbar: 100 }
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.join(' ')).toMatch(/strictly below initial/);

    const steadyRes = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { kind: 'steady', versionId: 'unknown-version' }
    });
    expect(steadyRes.statusCode).toBe(404);
  });

  it('returns 404 for missing job/version', async () => {
    expect((await app.inject({ method: 'GET', url: '/jobs/job_nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/versions/ver_nope' })).statusCode).toBe(404);
  });

  it('compare endpoint reports chambers beyond the ratio threshold', async () => {
    const v1 = (await app.inject({ method: 'POST', url: '/systems', payload: layout })).json();
    const wider: SystemVersionInput = {
      ...layout,
      edges: [
        { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 50, lengthM: 1 },
        {
          id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
          speedTable: [
            { pressureMbar: 0, speedLps: 10 },
            { pressureMbar: 1e-4, speedLps: 8 }
          ]
        }
      ]
    };
    const v2 = (
      await app.inject({
        method: 'POST',
        url: `/systems/${v1.systemId}/versions`,
        payload: { ...wider, nodes: [{ id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 1e-7 } }, { id: 'J', kind: 'junction' }] }
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: '/compare',
      payload: {
        oldVersionId: v1.versionId,
        newVersionId: v2.versionId,
        kind: 'steady',
        ratioThreshold: 0.1
      }
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.changedChambers).toContain('C');
    expect(report.entries[0]).toMatchObject({ chamberId: 'C', changed: true });
  });
});
