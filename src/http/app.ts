import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { MemoryStore } from '../storage/memory';
import { PgStore } from '../storage/postgres';
import type { Store } from '../storage/store';
import { JobScheduler } from '../jobs/scheduler';
import { registerSystemRoutes } from './routes/systems';
import { registerJobRoutes } from './routes/jobs';
import { registerCompareRoutes } from './routes/compare';

export interface AppDeps {
  store: Store;
  scheduler: JobScheduler;
}

export async function buildApp(store?: Store): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const actualStore = store ?? (await defaultStore());
  const scheduler = new JobScheduler(actualStore);

  app.get('/health', async () => ({ status: 'ok' }));
  registerSystemRoutes(app, actualStore);
  registerJobRoutes(app, actualStore, scheduler);
  registerCompareRoutes(app, actualStore, scheduler);

  app.setErrorHandler((err, _req, reply) => {
    const name = err.name ?? '';
    if (name === 'ValidationError') {
      return reply.status(400).send({
        error: 'validation_error',
        issues: (err as unknown as { issues: string[] }).issues ?? [err.message]
      });
    }
    if (name === 'NotFoundError') {
      return reply.status(404).send({ error: 'not_found', message: err.message });
    }
    if ((err as Error & { statusCode?: number }).statusCode === 400) {
      return reply.status(400).send({ error: 'bad_request', message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal_error', message: err.message });
  });

  return { app, deps: { store: actualStore, scheduler } };
}

async function defaultStore(): Promise<Store> {
  if (process.env.DATABASE_URL) {
    const pg = new PgStore();
    await pg.migrate();
    return pg;
  }
  return new MemoryStore();
}
