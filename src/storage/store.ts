import type {
  JobRecord,
  JobRequest,
  JobResult,
  JobStatus,
  SystemVersion,
  SystemVersionInput
} from '../types';

export interface CreateVersionInput {
  systemId?: string;
  input: SystemVersionInput;
}

/** Persistence port; implemented in-memory (tests/default) and by PostgreSQL. */
export interface Store {
  /**
   * Create a new immutable version. When systemId is omitted a new system is
   * started; otherwise the version is appended and its version number is the
   * previous max + 1.
   */
  createVersion(arg: CreateVersionInput): Promise<SystemVersion>;
  getVersion(versionId: string): Promise<SystemVersion | null>;
  listVersions(systemId?: string): Promise<SystemVersion[]>;
  /** All versions of one system ordered ascending. */
  listSystemVersions(systemId: string): Promise<SystemVersion[]>;
  getSystemIdForVersion(versionId: string): Promise<string | null>;

  insertJob(record: JobRecord): Promise<void>;
  updateJob(
    jobId: string,
    patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'error' | 'result' | 'startedAt' | 'finishedAt' | 'reused'>>
  ): Promise<void>;
  getJob(jobId: string): Promise<JobRecord | null>;
  findReusableJob(dedupKey: string): Promise<JobRecord | null>;
  listJobs(versionId?: string): Promise<JobRecord[]>;
  /** Register the dedup key for a queued/running/completed job. */
  attachDedupKey(jobId: string, dedupKey: string): Promise<void>;
  getDedupJobId(dedupKey: string): Promise<string | null>;

  close(): Promise<void>;
}

export type { JobRecord, JobRequest, JobResult, JobStatus };
