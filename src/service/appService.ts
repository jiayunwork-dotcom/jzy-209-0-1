import type {
  CalculationKind,
  CompareRequest,
  CompareResult,
  JobRecord,
  SteadyParams,
  SystemVersion,
  TransientParams,
  VacuumSystem
} from '../types';
import { NotFoundError, ValidationError } from '../errors';
import { assertValidSystem, assertNoValidationIssues, validateSteadyParams, validateTransientParams } from '../physics/validation';
import {
  physicalParamsHash,
  type ComparisonRepository,
  type JobRepository,
  type VersionRepository
} from '../db/repository';
import { JobScheduler } from './scheduler';
import { compareSteady, compareTransient } from './compare';
import type { SteadyResult, TransientResult } from '../types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AppServiceDeps {
  versions: VersionRepository;
  jobs: JobRepository;
  comparisons: ComparisonRepository;
  scheduler: JobScheduler;
}

export class AppService {
  constructor(private readonly deps: AppServiceDeps) {}

  async createVersion(system: VacuumSystem, parentVersionId?: string | null): Promise<SystemVersion> {
    assertValidSystem(system);
    if (parentVersionId) {
      const parent = await this.deps.versions.getVersion(parentVersionId);
      if (!parent) throw new NotFoundError(`parent version ${parentVersionId} not found`);
    }
    return this.deps.versions.createVersion({ system, parentVersionId: parentVersionId ?? null });
  }

  async getVersion(id: string): Promise<SystemVersion> {
    const version = await this.deps.versions.getVersion(id);
    if (!version) throw new NotFoundError(`version ${id} not found`);
    return version;
  }

  async listVersions(): Promise<SystemVersion[]> {
    return this.deps.versions.listVersions();
  }

  private validateJobParams(
    system: VacuumSystem,
    kind: CalculationKind,
    params: SteadyParams | TransientParams | undefined
  ): void {
    const issues =
      kind === 'steady'
        ? validateSteadyParams(system, params as SteadyParams | undefined)
        : validateTransientParams(system, params as TransientParams | undefined);
    assertNoValidationIssues(issues);
  }

  async submitJob(input: {
    versionId: string;
    kind: CalculationKind;
    params?: SteadyParams | TransientParams;
    hotStartFromJobId?: string | null;
  }): Promise<JobRecord> {
    const version = await this.getVersion(input.versionId);
    this.validateJobParams(version.system, input.kind, input.params);

    let hotSource: JobRecord | null = null;
    if (input.hotStartFromJobId) {
      hotSource = await this.deps.jobs.getJob(input.hotStartFromJobId);
      if (!hotSource) throw new NotFoundError(`hot start job ${input.hotStartFromJobId} not found`);
      if (hotSource.kind !== 'steady' || input.kind !== 'steady') {
        throw new ValidationError(['hot start is supported only for steady calculations']);
      }
    }

    const paramsHash = physicalParamsHash(input.kind, input.params ?? {});
    const reusable = await this.deps.jobs.findReusableJob({
      versionId: input.versionId,
      kind: input.kind,
      paramsHash,
      hotStartFromJobId: null
    });
    if (reusable) return reusable;

    return this.deps.jobs.createJob({
      versionId: input.versionId,
      kind: input.kind,
      params: input.params ?? {},
      paramsHash,
      hotStartFromJobId: input.hotStartFromJobId ?? hotSource?.id ?? null
    });
  }

  async getJob(id: string): Promise<JobRecord> {
    const job = await this.deps.jobs.getJob(id);
    if (!job) throw new NotFoundError(`job ${id} not found`);
    return job;
  }

  async listJobs(versionId?: string): Promise<JobRecord[]> {
    return this.deps.jobs.listJobs(versionId);
  }

  async cancelJob(id: string): Promise<JobRecord> {
    const job = await this.deps.jobs.getJob(id);
    if (!job) throw new NotFoundError(`job ${id} not found`);
    const updated = await this.deps.scheduler.cancel(id);
    return updated ?? job;
  }

  private async waitForJob(id: string, timeoutMs = 120000): Promise<JobRecord> {
    const deadline = Date.now() + timeoutMs;
    let last: JobRecord | null = null;
    while (Date.now() < deadline) {
      last = await this.deps.jobs.getJob(id);
      if (!last) throw new NotFoundError(`job ${id} not found`);
      if (last.status === 'succeeded' || last.status === 'failed' || last.status === 'cancelled') {
        return last;
      }
      await sleep(10);
    }
    return last!;
  }

  async compareVersions(request: CompareRequest): Promise<CompareResult & { comparisonId: string }> {
    const fromVersion = await this.getVersion(request.fromVersionId);
    const toVersion = await this.getVersion(request.toVersionId);
    const threshold = request.threshold ?? 0.1;
    if (!(threshold > 0)) throw new ValidationError(['threshold must be positive']);

    const params = request.params ?? {};
    this.validateJobParams(fromVersion.system, request.kind, params);
    this.validateJobParams(toVersion.system, request.kind, params);

    const fromJobInput = {
      versionId: fromVersion.id,
      kind: request.kind,
      params
    };
    const fromJob = await this.submitJob(fromJobInput);

    // Hot start maps stable node ids from the old steady solution to the new
    // network. If reuse returns an existing identical job, it is returned as-is.
    const toJob =
      request.hotStart && request.kind === 'steady'
        ? await this.submitJob({
            versionId: toVersion.id,
            kind: request.kind,
            params: params as SteadyParams,
            hotStartFromJobId: fromJob.id
          })
        : await this.submitJob({ versionId: toVersion.id, kind: request.kind, params });

    const [fromDone, toDone] = await Promise.all([
      this.waitForJob(fromJob.id),
      this.waitForJob(toJob.id)
    ]);

    if (fromDone.status !== 'succeeded' || toDone.status !== 'succeeded') {
      const result: CompareResult = {
        status: fromDone.status === 'cancelled' || toDone.status === 'cancelled' ? 'cancelled' : 'failed',
        threshold,
        fromJobId: fromJob.id,
        toJobId: toJob.id,
        changed: [],
        exceeds: [],
        addedNodes: [],
        removedNodes: []
      };
      const comparisonId = await this.deps.comparisons.saveComparison(
        {
          fromVersionId: fromVersion.id,
          toVersionId: toVersion.id,
          kind: request.kind,
          threshold,
          fromJobId: fromJob.id,
          toJobId: toJob.id
        },
        result
      );
      return { ...result, comparisonId };
    }

    const payload =
      request.kind === 'steady'
        ? compareSteady(
            fromVersion,
            toVersion,
            fromDone.result as SteadyResult,
            toDone.result as SteadyResult,
            threshold
          )
        : compareTransient(
            fromVersion,
            toVersion,
            fromDone.result as TransientResult,
            toDone.result as TransientResult,
            threshold
          );

    const result: CompareResult = {
      status: 'ready',
      threshold,
      fromJobId: fromJob.id,
      toJobId: toJob.id,
      ...payload
    };
    const comparisonId = await this.deps.comparisons.saveComparison(
      {
        fromVersionId: fromVersion.id,
        toVersionId: toVersion.id,
        kind: request.kind,
        threshold,
        fromJobId: fromJob.id,
        toJobId: toJob.id
      },
      result
    );
    return { ...result, comparisonId };
  }
}
