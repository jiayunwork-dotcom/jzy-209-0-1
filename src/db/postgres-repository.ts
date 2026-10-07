import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  CalculationKind,
  JobRecord,
  SteadyParams,
  SystemVersion,
  TransientParams,
  VacuumSystem
} from '../types';
import { hashObject } from '../util/hash';
import type {
  CreateJobInput,
  CreateVersionInput,
  JobRepository,
  VersionRepository
} from './repository';

interface VersionRow {
  id: string;
  parent_version_id: string | null;
  version: number;
  system: VacuumSystem;
  created_at: Date;
}

interface JobRow {
  id: string;
  version_id: string;
  kind: CalculationKind;
  params: SteadyParams | TransientParams;
  hot_start_from_job_id: string | null;
  params_hash: string;
  status: JobRecord['status'];
  progress: JobRecord['progress'];
  result: JobRecord['result'];
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function mapVersion(row: VersionRow): SystemVersion {
  return {
    id: row.id,
    parentVersionId: row.parent_version_id,
    version: row.version,
    system: row.system,
    createdAt: row.created_at.toISOString()
  };
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    versionId: row.version_id,
    kind: row.kind,
    params: row.params,
    hotStartFromJobId: row.hot_start_from_job_id,
    paramsHash: row.params_hash,
    status: row.status,
    progress: row.progress,
    result: row.result,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null
  };
}

export class PostgresVersionRepository implements VersionRepository {
  constructor(private readonly pool: Pool) {}

  async createVersion(input: CreateVersionInput): Promise<SystemVersion> {
    const id = input.id ?? randomUUID();
    const result = await this.pool.query<VersionRow>(
      `INSERT INTO system_versions(id, parent_version_id, version, system, system_hash)
       VALUES ($1, $2,
         COALESCE((SELECT version + 1 FROM system_versions WHERE id = $2),
                  (SELECT COALESCE(MAX(version), 0) + 1 FROM system_versions)),
         $3, $4)
       RETURNING *`,
      [id, input.parentVersionId ?? null, JSON.stringify(input.system), hashObject(input.system)]
    );
    return mapVersion(result.rows[0]!);
  }

  async getVersion(id: string): Promise<SystemVersion | null> {
    const result = await this.pool.query<VersionRow>('SELECT * FROM system_versions WHERE id=$1', [id]);
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async listVersions(limit = 100): Promise<SystemVersion[]> {
    const result = await this.pool.query<VersionRow>(
      'SELECT * FROM system_versions ORDER BY version DESC LIMIT $1',
      [limit]
    );
    return result.rows.map(mapVersion).reverse();
  }

  async latestVersion(): Promise<SystemVersion | null> {
    const result = await this.pool.query<VersionRow>(
      'SELECT * FROM system_versions ORDER BY version DESC LIMIT 1'
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly pool: Pool) {}

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const id = input.id ?? randomUUID();
    const result = await this.pool.query<JobRow>(
      `INSERT INTO jobs(id, version_id, kind, params, hot_start_from_job_id, params_hash)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        id,
        input.versionId,
        input.kind,
        JSON.stringify(input.params),
        input.hotStartFromJobId ?? null,
        input.paramsHash
      ]
    );
    return mapJob(result.rows[0]!);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>('SELECT * FROM jobs WHERE id=$1', [id]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async listJobs(versionId?: string): Promise<JobRecord[]> {
    if (versionId) {
      const result = await this.pool.query<JobRow>(
        'SELECT * FROM jobs WHERE version_id=$1 ORDER BY created_at',
        [versionId]
      );
      return result.rows.map(mapJob);
    }
    const result = await this.pool.query<JobRow>('SELECT * FROM jobs ORDER BY created_at');
    return result.rows.map(mapJob);
  }

  async findReusableJob(input: {
    versionId: string;
    kind: CalculationKind;
    paramsHash: string;
    hotStartFromJobId?: string | null;
  }): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT * FROM jobs
       WHERE version_id=$1 AND kind=$2 AND params_hash=$3
         AND status IN ('succeeded','queued','running')
       ORDER BY created_at
       LIMIT 1`,
      [input.versionId, input.kind, input.paramsHash]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async claimNextJob(): Promise<JobRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE status='queued'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const updated = await client.query<JobRow>(
        `UPDATE jobs SET status='running', started_at=COALESCE(started_at, now()),
          progress=progress || '{"status":"running"}'::jsonb
         WHERE id=$1 RETURNING *`,
        [row.id]
      );
      await client.query('COMMIT');
      return mapJob(updated.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateJob(
    id: string,
    patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'result' | 'error' | 'startedAt' | 'finishedAt'>>
  ): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE jobs SET
        status = COALESCE($2, status),
        progress = COALESCE($3, progress),
        result = COALESCE($4, result),
        error = COALESCE($5, error),
        started_at = COALESCE($6, started_at),
        finished_at = COALESCE($7, CASE WHEN $2 IS NOT NULL THEN now() ELSE finished_at END)
       WHERE id=$1 RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.progress ? JSON.stringify(patch.progress) : null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null
      ]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async markRunningJobsInterrupted(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE jobs SET status='queued',
       progress=progress || '{"status":"queued","message":"interrupted by service restart"}'::jsonb
       WHERE status='running'`
    );
    return result.rowCount ?? 0;
  }
}
