import { randomUUID } from 'node:crypto';
import type {
  CalculationKind,
  CompareResult,
  JobProgress,
  JobRecord,
  JobStatus,
  SteadyParams,
  SteadyResult,
  SystemVersion,
  TransientParams,
  VacuumSystem
} from '../types';
import { hashObject } from '../util/hash';

export interface CreateVersionInput {
  system: VacuumSystem;
  parentVersionId?: string | null;
  id?: string;
}

export interface CreateJobInput {
  versionId: string;
  kind: CalculationKind;
  params: SteadyParams | TransientParams;
  paramsHash: string;
  hotStartFromJobId?: string | null;
  id?: string;
}

export interface VersionRepository {
  createVersion(input: CreateVersionInput): Promise<SystemVersion>;
  getVersion(id: string): Promise<SystemVersion | null>;
  listVersions(limit?: number): Promise<SystemVersion[]>;
  latestVersion(): Promise<SystemVersion | null>;
}

export interface JobRepository {
  createJob(input: CreateJobInput): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(versionId?: string): Promise<JobRecord[]>;
  findReusableJob(input: {
    versionId: string;
    kind: CalculationKind;
    paramsHash: string;
    hotStartFromJobId?: string | null;
  }): Promise<JobRecord | null>;
  claimNextJob(): Promise<JobRecord | null>;
  updateJob(
    id: string,
    patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'result' | 'error' | 'startedAt' | 'finishedAt'>>
  ): Promise<JobRecord | null>;
  markRunningJobsInterrupted(): Promise<number>;
}

export interface ComparisonRepository {
  saveComparison(
    input: {
      fromVersionId: string;
      toVersionId: string;
      kind: CalculationKind;
      threshold: number;
      fromJobId: string;
      toJobId: string;
    },
    result?: CompareResult
  ): Promise<string>;
}

export function physicalParamsHash(
  kind: CalculationKind,
  params: SteadyParams | TransientParams | undefined
): string {
  // hotStart is deliberately not part of physical identity: it changes only the
  // initial guess, not the requested calculation.
  const physical: Record<string, unknown> = { kind, params: params ?? {} };
  return hashObject(physical);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryRepository implements VersionRepository, JobRepository, ComparisonRepository {
  public storedVersions = new Map<string, SystemVersion>();
  public storedJobs = new Map<string, JobRecord>();
  public storedComparisons = new Map<
    string,
    { id: string; fromVersionId: string; toVersionId: string; result?: CompareResult }
  >();
  private versionCounter = 0;
  private claiming = false;
  private claimWaiters: Array<() => void> = [];

  async createVersion(input: CreateVersionInput): Promise<SystemVersion> {
    const parent = input.parentVersionId ? this.storedVersions.get(input.parentVersionId) : null;
    if (input.parentVersionId && !parent) {
      throw new Error(`parent version ${input.parentVersionId} does not exist`);
    }
    this.versionCounter += 1;
    const version = parent ? parent.version + 1 : this.versionCounter;
    this.versionCounter = Math.max(this.versionCounter, version);
    const record: SystemVersion = {
      id: input.id ?? randomUUID(),
      parentVersionId: input.parentVersionId ?? null,
      version,
      system: input.system,
      createdAt: nowIso()
    };
    this.storedVersions.set(record.id, record);
    return record;
  }

  async getVersion(id: string): Promise<SystemVersion | null> {
    return this.storedVersions.get(id) ?? null;
  }

  async listVersions(limit = 100): Promise<SystemVersion[]> {
    return [...this.storedVersions.values()].sort((a, b) => a.version - b.version).slice(-limit);
  }

  async latestVersion(): Promise<SystemVersion | null> {
    const list = await this.listVersions(1);
    return list[0] ?? null;
  }

  private toRecord(input: CreateJobInput): JobRecord {
    return {
      id: input.id ?? randomUUID(),
      versionId: input.versionId,
      kind: input.kind,
      params: input.params,
      hotStartFromJobId: input.hotStartFromJobId ?? null,
      paramsHash: input.paramsHash,
      status: 'queued',
      progress: { status: 'queued' },
      result: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null
    };
  }

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const record = this.toRecord(input);
    this.storedJobs.set(record.id, record);
    return record;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.storedJobs.get(id) ?? null;
  }

  async listJobs(versionId?: string): Promise<JobRecord[]> {
    return [...this.storedJobs.values()]
      .filter((job) => !versionId || job.versionId === versionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findReusableJob(input: {
    versionId: string;
    kind: CalculationKind;
    paramsHash: string;
    hotStartFromJobId?: string | null;
  }): Promise<JobRecord | null> {
    for (const job of this.storedJobs.values()) {
      if (
        job.versionId === input.versionId &&
        job.kind === input.kind &&
        job.paramsHash === input.paramsHash &&
        (job.status === 'succeeded' || job.status === 'queued' || job.status === 'running')
      ) {
        return job;
      }
    }
    return null;
  }

  private async acquireClaimLock(): Promise<() => void> {
    while (this.claiming) {
      await new Promise<void>((resolve) => this.claimWaiters.push(resolve));
    }
    this.claiming = true;
    return () => {
      this.claiming = false;
      const waiter = this.claimWaiters.shift();
      if (waiter) waiter();
    };
  }

  async claimNextJob(): Promise<JobRecord | null> {
    const release = await this.acquireClaimLock();
    try {
      const next = [...this.storedJobs.values()]
        .filter((job) => job.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return null;
      next.status = 'running';
      next.startedAt = nowIso();
      next.progress = { ...next.progress, status: 'running' };
      return next;
    } finally {
      release();
    }
  }

  async updateJob(
    id: string,
    patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'result' | 'error' | 'startedAt' | 'finishedAt'>>
  ): Promise<JobRecord | null> {
    const record = this.storedJobs.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    return record;
  }

  async markRunningJobsInterrupted(): Promise<number> {
    let count = 0;
    for (const job of this.storedJobs.values()) {
      if (job.status === 'running') {
        job.status = 'queued';
        job.progress = { ...job.progress, status: 'queued', message: 'interrupted by service restart' };
        count++;
      }
    }
    return count;
  }

  async saveComparison(
    input: {
      fromVersionId: string;
      toVersionId: string;
      kind: CalculationKind;
      threshold: number;
      fromJobId: string;
      toJobId: string;
    },
    result?: CompareResult
  ): Promise<string> {
    const id = randomUUID();
    this.storedComparisons.set(id, { id, ...input, result });
    return id;
  }
}

export type { JobProgress, JobStatus };
