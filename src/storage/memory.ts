import type { JobRecord, SystemVersion } from '../types';
import { fingerprintSystem, generateId } from '../util/canonical';
import type { CreateVersionInput, Store } from './store';

interface SystemRow {
  systemId: string;
  createdAt: string;
}

/**
 * In-memory implementation of the Store. Used by the test suite and by the
 * default configuration when no DATABASE_URL is provided. Data does not survive
 * a process restart; PostgreSQL storage does.
 */
export class MemoryStore implements Store {
  private systems = new Map<string, SystemRow>();
  private versions = new Map<string, SystemVersion>();
  private jobs = new Map<string, JobRecord>();
  private dedup = new Map<string, string>();
  private systemVersions = new Map<string, string[]>();

  async createVersion(arg: CreateVersionInput): Promise<SystemVersion> {
    const fingerprint = fingerprintSystem(arg.input);
    let systemId = arg.systemId;
    if (!systemId) {
      systemId = generateId('sys');
      this.systems.set(systemId, { systemId, createdAt: new Date().toISOString() });
      this.systemVersions.set(systemId, []);
    } else if (!this.systems.has(systemId)) {
      // Explicit but unknown system id: start it.
      this.systems.set(systemId, { systemId, createdAt: new Date().toISOString() });
      this.systemVersions.set(systemId, []);
    }
    const existing = this.systemVersions.get(systemId)!;
    const version = existing.length + 1;
    const versionId = generateId('ver');
    const record: SystemVersion = {
      ...arg.input,
      systemId,
      versionId,
      version,
      createdAt: new Date().toISOString(),
      fingerprint
    };
    this.versions.set(versionId, record);
    existing.push(versionId);
    return record;
  }

  async getVersion(versionId: string): Promise<SystemVersion | null> {
    return this.versions.get(versionId) ?? null;
  }

  async listVersions(systemId?: string): Promise<SystemVersion[]> {
    if (systemId) return this.listSystemVersions(systemId);
    return [...this.versions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listSystemVersions(systemId: string): Promise<SystemVersion[]> {
    const ids = this.systemVersions.get(systemId) ?? [];
    return ids.map((id) => this.versions.get(id)!).filter(Boolean);
  }

  async getSystemIdForVersion(versionId: string): Promise<string | null> {
    return this.versions.get(versionId)?.systemId ?? null;
  }

  async insertJob(record: JobRecord): Promise<void> {
    this.jobs.set(record.jobId, { ...record });
  }

  async updateJob(jobId: string, patch: Partial<JobRecord>): Promise<void> {
    const cur = this.jobs.get(jobId);
    if (!cur) return;
    this.jobs.set(jobId, { ...cur, ...patch });
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ? { ...this.jobs.get(jobId)! } : null;
  }

  async findReusableJob(dedupKey: string): Promise<JobRecord | null> {
    const id = this.dedup.get(dedupKey);
    if (!id) return null;
    const job = this.jobs.get(id);
    if (!job) return null;
    // Only reusable while queued/running or after a successful completion.
    if (job.status === 'failed' || job.status === 'cancelled') return null;
    return { ...job };
  }

  async listJobs(versionId?: string): Promise<JobRecord[]> {
    const all = [...this.jobs.values()];
    return (versionId ? all.filter((j) => j.versionId === versionId) : all).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
  }

  async attachDedupKey(jobId: string, dedupKey: string): Promise<void> {
    this.dedup.set(dedupKey, jobId);
  }

  async getDedupJobId(dedupKey: string): Promise<string | null> {
    return this.dedup.get(dedupKey) ?? null;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
