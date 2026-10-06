import type {
  ComparisonEntry,
  ComparisonReport,
  JobKind,
  JobRequest,
  JobResult,
  PumpdownJobRequest,
  SteadyJobRequest,
  SystemVersion
} from '../types';
import type { Store } from '../storage/store';
import type { SubmitOutcome } from '../jobs/scheduler';

export interface CompareOptions {
  kind: JobKind;
  ratioThreshold: number;
  /** Common valve states applied to both versions. */
  valveStates?: SteadyJobRequest['valveStates'];
  initialPressureMbar?: number;
  target?: PumpdownJobRequest['target'];
  maxTimeS?: number;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Compare results of the same calculation on two versions.
 *
 * Chamber correspondence is by node id: ids in both versions are compared
 * directly; ids present on only one side are listed as added/removed.
 * Jobs are created through the scheduler, so repeated comparisons reuse cached
 * results instead of recomputing.
 */
export async function compareVersions(
  store: Store,
  submit: (versionId: string, req: JobRequest) => Promise<SubmitOutcome>,
  oldVersionId: string,
  newVersionId: string,
  opts: CompareOptions
): Promise<ComparisonReport> {
  const oldV = await store.getVersion(oldVersionId);
  const newV = await store.getVersion(newVersionId);
  if (!oldV) throw new NotFoundError(`old version not found: ${oldVersionId}`);
  if (!newV) throw new NotFoundError(`new version not found: ${newVersionId}`);
  if (oldV.systemId !== newV.systemId) {
    throw new Error('versions belong to different systems; comparison requires two versions of one system');
  }

  const oldReq: JobRequest =
    opts.kind === 'steady'
      ? {
          kind: 'steady',
          versionId: oldVersionId,
          valveStates: opts.valveStates
        }
      : {
          kind: 'pumpdown',
          versionId: oldVersionId,
          initialPressureMbar: opts.initialPressureMbar!,
          target: opts.target,
          maxTimeS: opts.maxTimeS,
          valveStates: opts.valveStates
        };
  const newReq: JobRequest =
    opts.kind === 'steady'
      ? { kind: 'steady', versionId: newVersionId, valveStates: opts.valveStates }
      : {
          kind: 'pumpdown',
          versionId: newVersionId,
          initialPressureMbar: opts.initialPressureMbar!,
          target: opts.target,
          maxTimeS: opts.maxTimeS,
          valveStates: opts.valveStates
        };

  const oldOutcome = await submit(oldVersionId, oldReq);
  const newOutcome = await submit(newVersionId, newReq);
  const oldJob = await awaitCompletion(store, oldOutcome.job.jobId);
  const newJob = await awaitCompletion(store, newOutcome.job.jobId);
  if (!oldJob.result || !newJob.result) {
    throw new Error('comparison jobs did not produce results (failed or cancelled)');
  }

  return buildReport(
    oldV,
    newV,
    oldJob.result,
    newJob.result,
    opts,
    oldJob.jobId,
    newJob.jobId
  );
}

async function awaitCompletion(store: Store, jobId: string, timeoutMs = 120000): Promise<{
  jobId: string;
  result?: JobResult;
  status: string;
}> {
  const start = Date.now();
  for (;;) {
    const job = await store.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} vanished`);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { jobId, result: job.result, status: job.status };
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for job ${jobId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buildReport(
  oldVersion: SystemVersion,
  newVersion: SystemVersion,
  oldRes: JobResult,
  newRes: JobResult,
  opts: CompareOptions,
  oldJobId: string,
  newJobId: string
): ComparisonReport {
  const oldChambers = new Set(oldVersion.nodes.filter((n) => n.kind === 'chamber').map((n) => n.id));
  const newChambers = new Set(newVersion.nodes.filter((n) => n.kind === 'chamber').map((n) => n.id));
  const added = [...newChambers].filter((id) => !oldChambers.has(id));
  const removed = [...oldChambers].filter((id) => !newChambers.has(id));

  const entries: ComparisonEntry[] = [];
  const metric = opts.kind === 'steady' ? 'limitingPressureMbar' : 'targetTimeS';

  for (const cid of [...oldChambers].filter((id) => newChambers.has(id))) {
    const oldValue = metricValue(oldRes, cid, metric);
    const newValue = metricValue(newRes, cid, metric);
    const entry = compareEntry(cid, opts.kind, metric, oldValue, newValue, opts.ratioThreshold);
    entries.push(entry);
  }

  const changedChambers = entries.filter((e) => e.changed).map((e) => e.chamberId);

  return {
    systemId: oldVersion.systemId,
    oldVersionId: oldVersion.versionId,
    newVersionId: newVersion.versionId,
    kind: opts.kind,
    ratioThreshold: opts.ratioThreshold,
    entries,
    changedChambers,
    addedChambers: added,
    removedChambers: removed,
    oldJobId,
    newJobId
  };
}

function metricValue(result: JobResult, chamberId: string, metric: string): number | null {
  if (result.kind === 'steady' && metric === 'limitingPressureMbar') {
    return result.chamberPressuresMbar[chamberId] ?? null;
  }
  if (result.kind === 'pumpdown' && metric === 'targetTimeS') {
    return result.targetTimesS[chamberId] ?? null;
  }
  return null;
}

function compareEntry(
  chamberId: string,
  kind: JobKind,
  metric: ComparisonEntry['metric'],
  oldValue: number | null,
  newValue: number | null,
  threshold: number
): ComparisonEntry {
  let relativeChange: number | null = null;
  let changed = false;
  if (oldValue !== null && newValue !== null) {
    if (oldValue !== 0) {
      relativeChange = Math.abs(newValue - oldValue) / Math.abs(oldValue);
      changed = relativeChange > threshold;
    } else {
      // Both-defined but zero baseline: any nonzero new value is a change.
      changed = newValue !== 0;
    }
  } else if (oldValue !== null || newValue !== null) {
    changed = true;
  }
  return { chamberId, kind, metric, oldValue, newValue, relativeChange, changed };
}
