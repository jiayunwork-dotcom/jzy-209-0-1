import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { JobRecord, JobRequest, JobResult, SystemVersion, SystemVersionInput } from '../types';
import { fingerprintSystem, generateId } from '../util/canonical';
import type { CreateVersionInput, Store } from './store';

/**
 * PostgreSQL-backed store. The complete system description is kept as JSONB
 * (the versions are immutable write-once documents), while the columns used
 * for lookup and listing (system id, version number, status, dedup key) are
 * normalised.
 */
export class PgStore implements Store {
  private readonly pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
      max: 10
    });
  }

  async migrate(): Promise<void> {
    // TypeScript compilation does not copy .sql files; try the compiled tree
    // (Docker copies them in) and fall back to the source tree.
    let sql: string;
    try {
      sql = await readFile(join(__dirname, 'migrations', '001_init.sql'), 'utf8');
    } catch {
      sql = await readFile(join(__dirname, '..', '..', 'src', 'storage', 'migrations', '001_init.sql'), 'utf8');
    }
    await this.pool.query(sql);
    // Any job left "running" by a crashed process is marked failed on startup.
    await this.pool.query(
      `UPDATE jobs SET status = 'failed', error = 'interrupted by service restart', finished_at = now()
       WHERE status IN ('running','queued')`
    );
  }

  async createVersion(arg: CreateVersionInput): Promise<SystemVersion> {
    const fingerprint = fingerprintSystem(arg.input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let systemId = arg.systemId;
      if (systemId) {
        await client.query(
          `INSERT INTO systems(id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [systemId]
        );
      } else {
        systemId = generateId('sys');
        await client.query('INSERT INTO systems(id) VALUES ($1)', [systemId]);
      }
      const verRes = await client.query(
        `SELECT COALESCE(MAX(version_no), 0) AS maxv FROM versions WHERE system_id = $1`,
        [systemId]
      );
      const version = (verRes.rows[0].maxv as number) + 1;
      const versionId = generateId('ver');
      const definition = JSON.stringify(arg.input);
      await client.query(
        `INSERT INTO versions (id, system_id, version_no, name, description, fingerprint, definition)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          versionId,
          systemId,
          version,
          arg.input.name ?? null,
          arg.input.description ?? null,
          fingerprint,
          definition
        ]
      );
      await client.query('COMMIT');
      return {
        ...arg.input,
        systemId,
        versionId,
        version,
        createdAt: new Date().toISOString(),
        fingerprint
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private mapVersion(row: Record<string, unknown>): SystemVersion {
    const input = row.definition as SystemVersionInput;
    return {
      ...input,
      systemId: row.system_id as string,
      versionId: row.id as string,
      version: row.version_no as number,
      createdAt: (row.created_at as Date).toISOString(),
      fingerprint: row.fingerprint as string
    };
  }

  async getVersion(versionId: string): Promise<SystemVersion | null> {
    const res = await this.pool.query(`SELECT * FROM versions WHERE id = $1`, [versionId]);
    return res.rows[0] ? this.mapVersion(res.rows[0]) : null;
  }

  async listVersions(systemId?: string): Promise<SystemVersion[]> {
    const res = systemId
      ? await this.pool.query(`SELECT * FROM versions WHERE system_id = $1 ORDER BY version_no`, [systemId])
      : await this.pool.query(`SELECT * FROM versions ORDER BY created_at`);
    return res.rows.map((r) => this.mapVersion(r));
  }

  async listSystemVersions(systemId: string): Promise<SystemVersion[]> {
    return this.listVersions(systemId);
  }

  async getSystemIdForVersion(versionId: string): Promise<string | null> {
    const res = await this.pool.query(`SELECT system_id FROM versions WHERE id = $1`, [versionId]);
    return (res.rows[0]?.system_id as string) ?? null;
  }

  async insertJob(record: JobRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO jobs (id, system_id, version_id, version_fingerprint, dedup_key, request, status, progress, error, result, created_at, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        record.jobId,
        record.systemId,
        record.versionId,
        record.versionFingerprint,
        null,
        JSON.stringify(record.request),
        record.status,
        record.progress,
        record.error ?? null,
        record.result ? JSON.stringify(record.result) : null,
        record.createdAt,
        record.startedAt ?? null,
        record.finishedAt ?? null
      ]
    );
  }

  async attachDedupKey(jobId: string, dedupKey: string): Promise<void> {
    await this.pool.query(`UPDATE jobs SET dedup_key = $2 WHERE id = $1`, [jobId, dedupKey]);
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'error' | 'result' | 'startedAt' | 'finishedAt' | 'reused'>>
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const map: Record<string, unknown> = {
      status: patch.status,
      progress: patch.progress,
      error: patch.error,
      result: patch.result ? JSON.stringify(patch.result) : undefined,
      started_at: patch.startedAt,
      finished_at: patch.finishedAt
    };
    for (const [col, val] of Object.entries(map)) {
      if (val === undefined) continue;
      sets.push(`${col} = $${i++}`);
      vals.push(val);
    }
    if (sets.length === 0) return;
    vals.push(jobId);
    await this.pool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  }

  private mapJob(row: Record<string, unknown>): JobRecord {
    return {
      jobId: row.id as string,
      systemId: row.system_id as string,
      versionId: row.version_id as string,
      versionFingerprint: row.version_fingerprint as string,
      request: row.request as JobRequest,
      status: row.status as JobRecord['status'],
      progress: Number(row.progress),
      error: (row.error as string) ?? undefined,
      result: (row.result as JobResult) ?? undefined,
      createdAt: (row.created_at as Date).toISOString(),
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
      finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : undefined
    };
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const res = await this.pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
    return res.rows[0] ? this.mapJob(res.rows[0]) : null;
  }

  async findReusableJob(dedupKey: string): Promise<JobRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM jobs WHERE dedup_key = $1 AND status IN ('queued','running','completed')`,
      [dedupKey]
    );
    return res.rows[0] ? this.mapJob(res.rows[0]) : null;
  }

  async listJobs(versionId?: string): Promise<JobRecord[]> {
    const res = versionId
      ? await this.pool.query(`SELECT * FROM jobs WHERE version_id = $1 ORDER BY created_at`, [versionId])
      : await this.pool.query(`SELECT * FROM jobs ORDER BY created_at`);
    return res.rows.map((r) => this.mapJob(r));
  }

  async getDedupJobId(dedupKey: string): Promise<string | null> {
    const res = await this.pool.query(`SELECT id FROM jobs WHERE dedup_key = $1`, [dedupKey]);
    return (res.rows[0]?.id as string) ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
