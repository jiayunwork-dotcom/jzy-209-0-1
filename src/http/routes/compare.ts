import type { FastifyInstance } from 'fastify';
import type { Store } from '../../storage/store';
import type { JobRequest } from '../../types';
import { validateJob } from '../../validation/validate';
import type { JobScheduler } from '../../jobs/scheduler';
import { compareVersions } from '../../versioning/compare';

interface CompareBody {
  oldVersionId: string;
  newVersionId: string;
  kind: 'steady' | 'pumpdown';
  ratioThreshold?: number;
  valveStates?: JobRequest extends infer T ? (T extends { valveStates?: infer V } ? V : never) : never;
  initialPressureMbar?: number;
  target?: { pressureMbar: number; chamberIds?: string[] };
  maxTimeS?: number;
}

export function registerCompareRoutes(app: FastifyInstance, store: Store, scheduler: JobScheduler): void {
  app.post('/compare', async (req, reply) => {
    const body = req.body as CompareBody;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'validation_error', issues: ['body required'] });
    }
    const ratio = body.ratioThreshold ?? 0.1;
    if (!(ratio >= 0)) {
      return reply.status(400).send({ error: 'validation_error', issues: ['ratioThreshold must be >= 0'] });
    }
    const oldV = await store.getVersion(body.oldVersionId);
    const newV = await store.getVersion(body.newVersionId);
    if (!oldV || !newV) {
      return reply.status(404).send({
        error: 'not_found',
        message: `unknown version(s): ${!oldV ? body.oldVersionId : ''} ${!newV ? body.newVersionId : ''}`.trim()
      });
    }

    // Build representative requests and validate them against each version so
    // that e.g. disconnected chambers are rejected before any job is created.
    const issues: string[] = [];
    const baseReq: JobRequest =
      body.kind === 'pumpdown'
        ? {
            kind: 'pumpdown',
            versionId: '',
            initialPressureMbar: body.initialPressureMbar ?? NaN,
            target: body.target,
            maxTimeS: body.maxTimeS,
            valveStates: body.valveStates
          }
        : { kind: 'steady', versionId: '', valveStates: body.valveStates };
    for (const v of [oldV, newV]) {
      const probe: JobRequest = { ...baseReq, versionId: v.versionId } as JobRequest;
      issues.push(...validateJob(v, probe));
    }
    if (issues.length) return reply.status(400).send({ error: 'validation_error', issues });

    const report = await compareVersions(
      store,
      async (versionId, r) => {
        const version = (await store.getVersion(versionId))!;
        return scheduler.submit(version, r);
      },
      body.oldVersionId,
      body.newVersionId,
      {
        kind: body.kind,
        ratioThreshold: ratio,
        valveStates: body.valveStates,
        initialPressureMbar: body.initialPressureMbar,
        target: body.target,
        maxTimeS: body.maxTimeS
      }
    );
    return report;
  });
}
