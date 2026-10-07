import { Pool, type PoolConfig } from 'pg';

export function createPool(config: PoolConfig = {}): Pool {
  return new Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    user: process.env.PGUSER ?? 'vacuum',
    password: process.env.PGPASSWORD ?? 'vacuum',
    database: process.env.PGDATABASE ?? 'vacuum',
    max: Number(process.env.PGPOOL_MAX ?? 10),
    ...config
  });
}

export type DbPool = Pool;
