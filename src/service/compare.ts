import type {
  ChamberChange,
  SteadyResult,
  SystemVersion,
  TransientResult
} from '../types';

function relativeChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  if (from === 0 && to === 0) return 0;
  if (from === 0) return to === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(to - from) / Math.abs(from);
}

function chamberIds(version: SystemVersion): Set<string> {
  return new Set(
    version.system.nodes.filter((node) => node.kind === 'chamber').map((node) => node.id)
  );
}

interface ComparisonPayload {
  changed: ChamberChange[];
  exceeds: ChamberChange[];
  addedNodes: string[];
  removedNodes: string[];
}

export function compareSteady(
  fromVersion: SystemVersion,
  toVersion: SystemVersion,
  fromResult: SteadyResult,
  toResult: SteadyResult,
  threshold: number
): ComparisonPayload {
  const fromIds = chamberIds(fromVersion);
  const toIds = chamberIds(toVersion);
  const fromPressure = new Map(fromResult.pressures.map((x) => [x.nodeId, x.pressure]));
  const toPressure = new Map(toResult.pressures.map((x) => [x.nodeId, x.pressure]));

  const changed: ChamberChange[] = [];
  for (const id of [...fromIds].sort()) {
    if (!toIds.has(id)) continue;
    const from = fromPressure.get(id) ?? null;
    const to = toPressure.get(id) ?? null;
    const rel = relativeChange(from, to);
    changed.push({
      nodeId: id,
      from,
      to,
      relativeChange: rel,
      exceedsThreshold: rel !== null && rel > threshold,
      metric: 'ultimatePressure'
    });
  }

  return {
    changed: changed.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    exceeds: changed.filter((x) => x.exceedsThreshold),
    addedNodes: [...toIds].filter((id) => !fromIds.has(id)).sort(),
    removedNodes: [...fromIds].filter((id) => !toIds.has(id)).sort()
  };
}

export function compareTransient(
  fromVersion: SystemVersion,
  toVersion: SystemVersion,
  fromResult: TransientResult,
  toResult: TransientResult,
  threshold: number
): { changed: ChamberChange[]; exceeds: ChamberChange[]; addedNodes: string[]; removedNodes: string[] } {
  const fromIds = chamberIds(fromVersion);
  const toIds = chamberIds(toVersion);
  const fromTime = new Map(fromResult.targetArrivals.map((x) => [x.nodeId, x.time]));
  const toTime = new Map(toResult.targetArrivals.map((x) => [x.nodeId, x.time]));

  const changed: ChamberChange[] = [];
  for (const id of [...fromIds].sort()) {
    if (!toIds.has(id)) continue;
    const from = fromTime.get(id) ?? null;
    const to = toTime.get(id) ?? null;
    const rel = relativeChange(from, to);
    changed.push({
      nodeId: id,
      from,
      to,
      relativeChange: rel,
      exceedsThreshold: rel !== null && rel > threshold,
      metric: 'pumpdownTime'
    });
  }

  return {
    changed: changed.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    exceeds: changed.filter((x) => x.exceedsThreshold),
    addedNodes: [...toIds].filter((id) => !fromIds.has(id)).sort(),
    removedNodes: [...fromIds].filter((id) => !toIds.has(id)).sort()
  };
}
