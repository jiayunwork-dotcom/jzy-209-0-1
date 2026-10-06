import type {
  JobRecord,
  JobRequest,
  JobResult,
  SystemVersion
} from '../types';
import { runPumpdown } from './pumpdown';
import { runSteady } from './steady';
import type { CancellationToken } from '../numeric/newton';
import type { Store } from '../storage/store';

export interface RunContext {
  token: CancellationToken;
  /** Called with 0..1 as a best-effort progress estimate. */
  onProgress?: (fraction: number) => void;
}

/**
 * Execute one job request against an immutable system version.
 *
 * Hot start: when hotStartFromJobId is given, the previous result's node
 * pressures (steady) or initial pressures (pump-down) are transferred by node
 * id. Nodes that only exist in the old version are ignored; nodes new in the
 * current version keep the cold-start value. This deliberately matches on
 * stable node ids across versions rather than on indices.
 */
export async function executeJob(
  version: SystemVersion,
  req: JobRequest,
  store: Store,
  ctx: RunContext
): Promise<JobResult> {
  const hotMap = await loadHotStart(req, store);
  // For pump-down runs the physical initial condition is fixed by
  // initialPressureMbar; a previous solution is only used to warm-start the
  // junction pressure guesses, so chamber ids are filtered out.
  const initialPressures =
    req.kind === 'pumpdown'
      ? filterToJunctions(version, hotMap)
      : hotMap;

  if (req.kind === 'steady') {
    const result = await runSteady(version, {
      valveStates: req.valveStates,
      maxIterations: req.maxIterations,
      tolerance: req.tolerance,
      initialPressures,
      token: ctx.token
    });
    ctx.onProgress?.(1);
    return result;
  }

  const result = await runPumpdown(version, {
    initialPressureMbar: req.initialPressureMbar,
    target: req.target,
    maxTimeS: req.maxTimeS,
    valveStates: req.valveStates,
    maxIterations: req.maxIterations,
    tolerance: req.tolerance,
    relTol: req.relTol,
    absTol: req.absTol,
    maxStepS: req.maxStepS,
    initialPressures,
    token: ctx.token
  });
  ctx.onProgress?.(1);
  return result;
}

function filterToJunctions(
  version: SystemVersion,
  map: Record<string, number> | undefined
): Record<string, number> | undefined {
  if (!map) return undefined;
  const junctionIds = new Set(version.nodes.filter((n) => n.kind === 'junction').map((n) => n.id));
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(map)) {
    if (junctionIds.has(id)) out[id] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

async function loadHotStart(
  req: JobRequest,
  store: Store
): Promise<Record<string, number> | undefined> {
  if (!req.hotStartFromJobId) return undefined;
  const prev: JobRecord | null = await store.getJob(req.hotStartFromJobId);
  if (!prev || !prev.result) return undefined;

  if (prev.result.kind === 'steady') {
    // Limiting/node pressures are the natural initial iterate.
    return { ...prev.result.pressuresMbar };
  }
  // Pump-down: the old run's t=0 state (first curve point) is the seed.
  const first = prev.result.curve[0];
  return first ? { ...first.pressuresMbar } : undefined;
}
