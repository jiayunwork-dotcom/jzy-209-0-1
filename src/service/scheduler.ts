import type { JobRecord, SteadyResult, SystemVersion } from '../types';
import { CancellationError } from '../errors';
import type { JobRepository, VersionRepository } from '../db/repository';
import { runCalculation } from './calculation';

export interface SchedulerDeps {
  jobs: JobRepository;
  versions: VersionRepository;
  pollIntervalMs?: number;
  autoStart?: boolean;
  concurrency?: number;
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly autoStart: boolean;
  private readonly concurrency: number;
  private activeExecutions = 0;
  private readonly tokens = new Map<string, { cancelled: boolean }>();
  private readonly cancellationRequests = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 20;
    this.autoStart = deps.autoStart ?? true;
    this.concurrency = deps.concurrency ?? 2;
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.pump();
    }, this.pollIntervalMs);
    if (this.autoStart) void this.pump();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cancel(jobId: string): Promise<JobRecord | null> {
    const job = await this.deps.jobs.getJob(jobId);
    if (!job) return null;
    const token = this.tokens.get(jobId);
    if (token) token.cancelled = true;
    this.cancellationRequests.add(jobId);
    if (job.status === 'queued') {
      return this.deps.jobs.updateJob(jobId, {
        status: 'cancelled',
        progress: { status: 'cancelled' },
        finishedAt: new Date().toISOString()
      });
    }
    if (job.status === 'running' && token) {
      return this.deps.jobs.updateJob(jobId, {
        progress: { ...job.progress, status: 'running', message: 'cancellation requested' }
      });
    }
    return job;
  }

  async pump(): Promise<void> {
    if (!this.running) return;
    while (this.activeExecutions < this.concurrency) {
      const job = await this.deps.jobs.claimNextJob();
      if (!job) return;
      this.activeExecutions++;
      void this.execute(job.id).finally(() => {
        this.activeExecutions--;
      });
    }
  }

  async execute(jobId: string): Promise<void> {
    const job = await this.deps.jobs.getJob(jobId);
    if (!job || job.status !== 'running') return;
    const version = await this.deps.versions.getVersion(job.versionId);
    if (!version) {
      await this.deps.jobs.updateJob(jobId, {
        status: 'failed',
        error: `version ${job.versionId} not found`,
        finishedAt: new Date().toISOString()
      });
      return;
    }

    const token = { cancelled: this.cancellationRequests.has(jobId) };
    this.tokens.set(jobId, token);
    try {
      let hotStart: SteadyResult | undefined;
      if (job.hotStartFromJobId && job.kind === 'steady') {
        const source = await this.deps.jobs.getJob(job.hotStartFromJobId);
        if (source?.status === 'succeeded' && source.result) {
          hotStart = source.result as SteadyResult;
        }
      }

      const result = runCalculation(version, job.kind, job.params, {
        hotStartResult: hotStart,
        cancelToken: token,
        onProgress: (progress) => {
          void this.deps.jobs.updateJob(jobId, {
            progress: {
              status: 'running',
              ...progress
            }
          });
        }
      });

      if (token.cancelled) throw new CancellationError();
      await this.deps.jobs.updateJob(jobId, {
        status: 'succeeded',
        result,
        progress: {
          status: 'succeeded',
          finalResidual: result.finalResidual,
          converged: result.converged
        },
        finishedAt: new Date().toISOString()
      });
    } catch (err) {
      if (err instanceof CancellationError || token.cancelled) {
        await this.deps.jobs.updateJob(jobId, {
          status: 'cancelled',
          progress: { status: 'cancelled' },
          finishedAt: new Date().toISOString()
        });
      } else {
        await this.deps.jobs.updateJob(jobId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          progress: { status: 'failed', message: err instanceof Error ? err.message : String(err) },
          finishedAt: new Date().toISOString()
        });
      }
    } finally {
      this.tokens.delete(jobId);
      this.cancellationRequests.delete(jobId);
    }
  }
}
