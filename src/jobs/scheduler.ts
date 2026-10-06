import type { JobRecord, JobRequest, SystemVersion } from '../types';
import type { Store } from '../storage/store';
import { generateId, jobDedupKey } from '../util/canonical';
import { ValidationError } from '../validation/validate';
import { executeJob } from '../compute/runner';
import type { CancellationToken } from '../numeric/newton';

export interface SubmitOutcome {
  job: JobRecord;
  /** True when an existing queued/running/completed job was returned instead of computing again. */
  reused: boolean;
}

/**
 * In-process FIFO job scheduler.
 *
 *  - one job runs at a time (the numerical kernels are CPU bound and the
 *    expected load is an engineering team, not a public API);
 *  - identical physical requests on the same version share one job record
 *    (dedup key excludes run-control flags and the hot-start pointer);
 *  - cancellation flips a token that the kernels observe between iterations,
 *    so a queued job never starts and a running job stops promptly.
 */
export class JobScheduler {
  private readonly store: Store;
  private readonly queue: string[] = [];
  private readonly tokens = new Map<string, CancellationToken>();
  private running: string | null = null;
  private drainScheduled = false;

  constructor(store: Store) {
    this.store = store;
  }

  async submit(version: SystemVersion, request: JobRequest): Promise<SubmitOutcome> {
    const dedup = jobDedupKey(version.versionId, version.fingerprint, request);
    const existing = await this.store.findReusableJob(dedup);
    if (existing) {
      return { job: existing, reused: true };
    }

    const jobId = generateId('job');
    const now = new Date().toISOString();
    const record: JobRecord = {
      jobId,
      systemId: version.systemId,
      versionId: version.versionId,
      request,
      status: 'queued',
      progress: 0,
      createdAt: now,
      versionFingerprint: version.fingerprint
    };
    await this.store.insertJob(record);
    await this.store.attachDedupKey(jobId, dedup);
    this.tokens.set(jobId, { cancelled: false });
    this.queue.push(jobId);
    this.scheduleDrain();
    return { job: record, reused: false };
  }

  async cancel(jobId: string): Promise<JobRecord | null> {
    const job = await this.store.getJob(jobId);
    if (!job) return null;
    if (job.status === 'queued') {
      const qi = this.queue.indexOf(jobId);
      if (qi >= 0) this.queue.splice(qi, 1);
      this.tokens.delete(jobId);
      await this.store.updateJob(jobId, {
        status: 'cancelled',
        finishedAt: new Date().toISOString()
      });
      return this.store.getJob(jobId);
    }
    if (job.status === 'running') {
      this.tokens.get(jobId)!.cancelled = true;
      // The running loop observes the flag and records its own terminal state;
      // report the request as accepted immediately.
      return job;
    }
    return job; // completed/failed/cancelled: no change
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.running) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const jobId = this.queue.shift();
    if (!jobId) return;
    const job = await this.store.getJob(jobId);
    if (!job || job.status === 'cancelled') {
      this.tokens.delete(jobId);
      this.afterJob();
      return;
    }

    this.running = jobId;
    const token = this.tokens.get(jobId) ?? { cancelled: false };
    await this.store.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });

    try {
      const version = await this.store.getVersion(job.versionId);
      if (!version) throw new Error(`version ${job.versionId} no longer exists`);
      const result = await executeJob(version, job.request, this.store, {
        token,
        onProgress: (fraction) => {
          void this.store.updateJob(jobId, { progress: fraction });
        }
      });
      if (token.cancelled) {
        await this.store.updateJob(jobId, {
          status: 'cancelled',
          progress: 1,
          result,
          finishedAt: new Date().toISOString()
        });
      } else {
        await this.store.updateJob(jobId, {
          status: 'completed',
          progress: 1,
          result,
          finishedAt: new Date().toISOString()
        });
      }
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : (err as Error).message;
      await this.store.updateJob(jobId, {
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString()
      });
    } finally {
      this.tokens.delete(jobId);
      this.running = null;
      this.afterJob();
    }
  }

  private afterJob(): void {
    if (this.queue.length > 0) this.scheduleDrain();
  }
}
