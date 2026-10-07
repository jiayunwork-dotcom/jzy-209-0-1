import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool } from './pool';

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const sql = await readFile(join(__dirname, 'migrations', '001_initial.sql'), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(
        `INSERT INTO schema_migrations(version) VALUES (1)
         ON CONFLICT (version) DO NOTHING`
      );
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
    console.log('database migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
