import type { FastifyInstance } from 'fastify';
import type { Store } from '../../storage/store';
import type { JobRequest } from '../../types';
import { validateJob } from '../../validation/validate';
import type { JobScheduler } from '../../jobs/scheduler';

export function registerJobRoutes(app: FastifyInstance, store: Store, scheduler: JobScheduler): void {
  app.post('/jobs', async (req, reply) => {
    const request = req.body as JobRequest;
    if (!request || typeof request !== 'object' || (request.kind !== 'steady' && request.kind !== 'pumpdown')) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: ['request body must be a steady or pumpdown job object with a versionId']
      });
    }
    const version = await store.getVersion(request.versionId);
    if (!version) {
      return reply.status(404).send({ error: 'not_found', message: `unknown version ${request.versionId}` });
    }
    const issues = validateJob(version, request);
    if (issues.length) return reply.status(400).send({ error: 'validation_error', issues });

    // Hot-start source must exist.
    if (request.hotStartFromJobId) {
      const src = await store.getJob(request.hotStartFromJobId);
      if (!src) {
        return reply
          .status(400)
          .send({ error: 'validation_error', issues: [`hotStartFromJobId unknown: ${request.hotStartFromJobId}`] });
      }
    }

    const { job, reused } = await scheduler.submit(version, request);
    return reply.status(202).send({ jobId: job.jobId, status: job.status, reused });
  });

  app.get('/jobs', async (req) => {
    const query = req.query as { versionId?: string };
    const jobs = await store.listJobs(query.versionId);
    return { jobs: jobs.map(serialize) };
  });

  app.get('/jobs/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = await store.getJob(jobId);
    if (!job) return reply.status(404).send({ error: 'not_found', message: `unknown job ${jobId}` });
    return serialize(job);
  });

  app.post('/jobs/:jobId/cancel', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const updated = await scheduler.cancel(jobId);
    if (!updated) return reply.status(404).send({ error: 'not_found', message: `unknown job ${jobId}` });
    return serialize(updated);
  });
}

function serialize(job: Awaited<ReturnType<Store['getJob']>> extends infer T ? NonNullable<T> : never) {
  return {
    jobId: job.jobId,
    systemId: job.systemId,
    versionId: job.versionId,
    versionFingerprint: job.versionFingerprint,
    request: job.request,
    status: job.status,
    progress: job.progress,
    error: job.error,
    result: job.result,
    reused: job.reused,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}
