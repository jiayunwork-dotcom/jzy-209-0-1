import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createApp, type CreatedApp } from '../src/app';
import { registerRoutes } from '../src/http/routes';
import type { VacuumSystem } from '../src/types';

const system: VacuumSystem = {
  nodes: [
    { id: 'chamber', kind: 'chamber', volume: 100, outgassing: { kind: 'constant', rate: 1e-6 } },
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
};

async function buildHttp(): Promise<{ app: FastifyInstance; created: CreatedApp }> {
  const created = createApp({ autoStartScheduler: true, pollIntervalMs: 5 });
  const app = Fastify();
  registerRoutes(app, created.service);
  return { app, created };
}

describe('HTTP API', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('creates versions and rejects invalid systems with issue details', async () => {
    const { app, created } = await buildHttp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/versions',
      payload: { system: { ...system, nodes: [{ id: 'bad', kind: 'chamber', volume: -1 }] } }
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('validation_failed');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.join(' ')).toMatch(/chambers without any path|volume/);
    created.scheduler.stop();
  });

  it('submits a steady job, returns job id and eventually a converged result', async () => {
    const { app, created } = await buildHttp();
    apps.push(app);
    const versionResponse = await app.inject({
      method: 'POST',
      url: '/versions',
      payload: { system }
    });
    const version = versionResponse.json();
    const submit = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { versionId: version.id, kind: 'steady', params: { initialPressure: 1e-5 } }
    });
    expect(submit.statusCode).toBe(202);
    const job = submit.json();
    expect(job.id).toBeTruthy();

    let terminal: { status: string; result?: { converged: boolean } };
    const deadline = Date.now() + 10000;
    do {
      const poll = await app.inject({ method: 'GET', url: `/jobs/${job.id}` });
      terminal = poll.json();
      if (['succeeded', 'failed', 'cancelled'].includes(terminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    expect(terminal.status).toBe('succeeded');
    expect(terminal.result!.converged).toBe(true);
    created.scheduler.stop();
  });
});
