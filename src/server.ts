import { createApp } from './app';
import { createPool } from './db/pool';
import { PostgresJobRepository, PostgresVersionRepository } from './db/postgres-repository';
import { PostgresComparisonRepository } from './db/postgres-comparison-repository';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  if (process.env.STORAGE === 'memory') {
    const created = createApp({ logger: true });
    created.scheduler.start();
    await created.app.listen({ port, host });
    return;
  }

  const pool = createPool();
  const versions = new PostgresVersionRepository(pool);
  const jobs = new PostgresJobRepository(pool);
  const comparisons = new PostgresComparisonRepository(pool);
  const created = createApp({
    repositories: { versions, jobs, comparisons },
    logger: true
  });
  await jobs.markRunningJobsInterrupted();
  created.scheduler.start();
  await created.app.listen({ port, host });

  const shutdown = async () => {
    created.scheduler.stop();
    await created.app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
