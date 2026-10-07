import type { FastifyInstance } from 'fastify';
import type { AppService } from '../service/appService';
import { CancellationError, NotFoundError, SolverError, ValidationError } from '../errors';
import type { CalculationKind, CompareRequest, SteadyParams, TransientParams, VacuumSystem } from '../types';

interface CreateVersionBody {
  system?: VacuumSystem;
  parentVersionId?: string | null;
}

interface SubmitJobBody {
  versionId?: string;
  kind?: CalculationKind;
  params?: SteadyParams | TransientParams;
  hotStartFromJobId?: string | null;
}

export function registerRoutes(app: FastifyInstance, service: AppService): void {
  app.get('/health', async () => ({ ok: true }));

  app.post('/versions', async (request, reply) => {
    const body = request.body as CreateVersionBody;
    if (!body?.system) {
      return reply.code(400).send({ error: 'system is required' });
    }
    const version = await service.createVersion(body.system, body.parentVersionId ?? null);
    return reply.code(201).send(version);
  });

  app.get('/versions', async () => service.listVersions());
  app.get('/versions/:id', async (request) => {
    const { id } = request.params as { id: string };
    return service.getVersion(id);
  });

  app.post('/jobs', async (request, reply) => {
    const body = request.body as SubmitJobBody;
    if (body?.kind !== 'steady' && body?.kind !== 'transient') {
      return reply.code(400).send({ error: "kind must be 'steady' or 'transient'" });
    }
    if (!body.versionId) return reply.code(400).send({ error: 'versionId is required' });
    const job = await service.submitJob({
      versionId: body.versionId,
      kind: body.kind,
      params: body.params ?? {},
      hotStartFromJobId: body.hotStartFromJobId ?? null
    });
    return reply.code(202).send(job);
  });

  app.get('/jobs', async (request) => {
    const query = request.query as { versionId?: string };
    return service.listJobs(query.versionId);
  });

  app.get('/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return service.getJob(id);
  });

  app.post('/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await service.cancelJob(id));
  });

  app.post('/compare', async (request) => {
    const body = request.body as CompareRequest;
    return service.compareVersions(body);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: error.message,
        issues: error.issues
      });
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: error.message });
    }
    if (error instanceof CancellationError) {
      return reply.code(409).send({ error: 'cancelled', message: error.message });
    }
    if (error instanceof SolverError) {
      return reply.code(422).send({ error: 'solver_error', message: error.message });
    }
    _request.log.error(error);
    return reply.code(500).send({ error: 'internal_error', message: error.message });
  });
}
