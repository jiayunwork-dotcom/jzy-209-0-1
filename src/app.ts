import Fastify, { type FastifyInstance } from 'fastify';
import { AppService } from './service/appService';
import { JobScheduler } from './service/scheduler';
import {
  InMemoryRepository,
  type ComparisonRepository,
  type JobRepository,
  type VersionRepository
} from './db/repository';
import { registerRoutes } from './http/routes';

export interface AppRepositories {
  versions: VersionRepository;
  jobs: JobRepository;
  comparisons: ComparisonRepository;
}

export interface CreateAppOptions {
  repositories?: AppRepositories;
  autoStartScheduler?: boolean;
  pollIntervalMs?: number;
  logger?: boolean;
}

export interface CreatedApp {
  app: FastifyInstance;
  service: AppService;
  scheduler: JobScheduler;
  repositories: AppRepositories;
}

export function createApp(options: CreateAppOptions = {}): CreatedApp {
  const repositories: AppRepositories =
    options.repositories ??
    (() => {
      const store = new InMemoryRepository();
      return { versions: store, jobs: store, comparisons: store };
    })();
  const scheduler = new JobScheduler({
    versions: repositories.versions,
    jobs: repositories.jobs,
    autoStart: options.autoStartScheduler ?? true,
    pollIntervalMs: options.pollIntervalMs ?? 10
  });
  const service = new AppService({ ...repositories, scheduler });
  if (options.autoStartScheduler ?? true) scheduler.start();
  const app = Fastify({ logger: options.logger ?? false });
  registerRoutes(app, service);
  app.addHook('onClose', async () => scheduler.stop());
  return { app, service, scheduler, repositories };
}
