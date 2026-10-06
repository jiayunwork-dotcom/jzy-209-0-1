import { buildApp } from './http/app';
import { PgStore } from './storage/postgres';

async function main(): Promise<void> {
  const { app, deps } = await buildApp();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await deps.store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host });
  app.log.info(
    { port, host, storage: process.env.DATABASE_URL ? 'postgresql' : 'memory' },
    'vacuum network service listening'
  );

  // Keep the idle PostgreSQL pool referenced so tree-shaking style bundlers do
  // not drop the import (no-op under plain CommonJS).
  void PgStore;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
