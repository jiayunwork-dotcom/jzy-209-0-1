import type {
  PumpEdge,
  SteadyParams,
  SystemEdge,
  SystemNode,
  TransientParams,
  VacuumSystem,
  ValveEdge
} from '../types';
import { ValidationError } from '../errors';
import { GAS_KIND } from './constants';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requirePositive(value: unknown, path: string, issues: string[]): void {
  if (!isFiniteNumber(value) || value <= 0) {
    issues.push(`${path} must be a finite positive number`);
  }
}

function requireNonNegative(value: unknown, path: string, issues: string[]): void {
  if (!isFiniteNumber(value) || value < 0) {
    issues.push(`${path} must be a finite non-negative number`);
  }
}

function validatePump(edge: PumpEdge, issues: string[]): void {
  if (!Array.isArray(edge.curve) || edge.curve.length < 2) {
    issues.push(`pump ${edge.id} curve must contain at least two pressure/speed points`);
    return;
  }
  let previousPressure = Number.NEGATIVE_INFINITY;
  edge.curve.forEach((point, i) => {
    const p = point?.pressure;
    const s = point?.speed;
    requireNonNegative(p, `pump ${edge.id}.curve[${i}].pressure`, issues);
    requireNonNegative(s, `pump ${edge.id}.curve[${i}].speed`, issues);
    if (typeof p === 'number' && Number.isFinite(p)) {
      if (p <= previousPressure) {
        issues.push(`pump ${edge.id} curve pressures must be strictly increasing at index ${i}`);
      }
      previousPressure = p;
    }
  });
  if (edge.startPressure !== undefined) {
    requireNonNegative(edge.startPressure, `pump ${edge.id}.startPressure`, issues);
  }
}

/** Structural validation independent of a particular valve configuration. */
export function validateSystem(system: VacuumSystem): string[] {
  const issues: string[] = [];
  if (!system || typeof system !== 'object') {
    return ['system must be an object'];
  }
  if (system.gas !== undefined && !Object.hasOwn(GAS_KIND, system.gas)) {
    issues.push(`unsupported gas species ${String(system.gas)}`);
  }
  if (system.temperature !== undefined) {
    requirePositive(system.temperature, 'temperature', issues);
  }
  if (!Array.isArray(system.nodes) || system.nodes.length === 0) {
    issues.push('nodes must be a non-empty array');
    return issues;
  }
  if (!Array.isArray(system.edges)) {
    issues.push('edges must be an array');
    return issues;
  }

  const nodeIds = new Set<string>();
  const chambers = new Set<string>();
  for (const node of system.nodes as SystemNode[]) {
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      issues.push('every node must have a non-empty string id');
      continue;
    }
    if (nodeIds.has(node.id)) {
      issues.push(`duplicate node id ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.kind === 'chamber') {
      chambers.add(node.id);
      requirePositive(node.volume, `node ${node.id}.volume`, issues);
      const q = node.outgassing;
      if (q) {
        if (q.kind === 'constant') {
          requireNonNegative(q.rate, `node ${node.id}.outgassing.rate`, issues);
        } else if (q.kind === 'exponential') {
          requireNonNegative(q.rate0, `node ${node.id}.outgassing.rate0`, issues);
          requirePositive(q.tau, `node ${node.id}.outgassing.tau`, issues);
        } else if (q.kind === 'power') {
          requireNonNegative(q.rate0, `node ${node.id}.outgassing.rate0`, issues);
          requirePositive(q.alpha, `node ${node.id}.outgassing.alpha`, issues);
          if (q.t0 !== undefined) requirePositive(q.t0, `node ${node.id}.outgassing.t0`, issues);
        } else {
          issues.push(`node ${node.id} has an unknown outgassing model`);
        }
      }
    } else if ((node as { kind?: string }).kind !== 'junction') {
      const unknownNode = node as { id: string; kind: unknown };
      issues.push(`node ${unknownNode.id} has unknown kind ${String(unknownNode.kind)}`);
    }
  }

  const edgeIds = new Set<string>();
  const pumpsFrom = new Set<string>();
  const undirectedAdjacency = new Map<string, string[]>();
  const addAdj = (a: string, b: string): void => {
    undirectedAdjacency.set(a, [...(undirectedAdjacency.get(a) ?? []), b]);
    undirectedAdjacency.set(b, [...(undirectedAdjacency.get(b) ?? []), a]);
  };

  for (const edge of system.edges as SystemEdge[]) {
    if (!edge || typeof edge.id !== 'string' || edge.id.length === 0) {
      issues.push('every edge must have a non-empty string id');
      continue;
    }
    if (edgeIds.has(edge.id)) issues.push(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);

    if (edge.kind === 'pipe') {
      if (!nodeIds.has(edge.a)) issues.push(`pipe ${edge.id} endpoint a=${edge.a} does not exist`);
      if (!nodeIds.has(edge.b)) issues.push(`pipe ${edge.id} endpoint b=${edge.b} does not exist`);
      requirePositive(edge.diameter, `pipe ${edge.id}.diameter`, issues);
      requirePositive(edge.length, `pipe ${edge.id}.length`, issues);
      if (nodeIds.has(edge.a) && nodeIds.has(edge.b)) addAdj(edge.a, edge.b);
    } else if (edge.kind === 'valve') {
      if (!nodeIds.has(edge.a)) issues.push(`valve ${edge.id} endpoint a=${edge.a} does not exist`);
      if (!nodeIds.has(edge.b)) issues.push(`valve ${edge.id} endpoint b=${edge.b} does not exist`);
      if (nodeIds.has(edge.a) && nodeIds.has(edge.b)) addAdj(edge.a, edge.b);
    } else if (edge.kind === 'pump') {
      if (!nodeIds.has(edge.from)) issues.push(`pump ${edge.id} from=${edge.from} does not exist`);
      else {
        pumpsFrom.add(edge.from);
        // Pump is a path to vacuum; mark self by no ordinary BFS target needed.
        if (!undirectedAdjacency.has(edge.from)) undirectedAdjacency.set(edge.from, []);
      }
      validatePump(edge, issues);
    } else {
      const unknownEdge = edge as { id: string };
      issues.push(`edge ${unknownEdge.id} has unknown kind`);
    }
  }

  if (issues.length === 0) {
    const disconnected = chambersWithoutPumpPath(chambers, pumpsFrom, undirectedAdjacency);
    if (disconnected.length > 0) {
      issues.push(
        `chambers without any path to a pump: ${disconnected.slice().sort().join(', ')}`
      );
    }
  }

  return issues;
}

export function chambersWithoutPumpPath(
  chambers: Set<string>,
  pumpInlets: Set<string>,
  adjacency: Map<string, string[]>
): string[] {
  const canReachPump = new Set<string>();
  for (const start of pumpInlets) {
    if (canReachPump.has(start)) continue;
    const stack = [start];
    canReachPump.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const nxt of adjacency.get(cur) ?? []) {
        if (!canReachPump.has(nxt)) {
          canReachPump.add(nxt);
          stack.push(nxt);
        }
      }
    }
  }
  return [...chambers].filter((id) => !canReachPump.has(id)).sort();
}

export function assertValidSystem(system: VacuumSystem): void {
  const issues = validateSystem(system);
  if (issues.length > 0) throw new ValidationError(issues);
}

export function valveIsOpen(edge: ValveEdge, overrides?: Record<string, boolean>): boolean {
  if (overrides && Object.hasOwn(overrides, edge.id)) return Boolean(overrides[edge.id]);
  return edge.defaultOpen ?? false;
}

export function validateValveOverrides(
  system: VacuumSystem,
  overrides?: Record<string, boolean>
): string[] {
  const issues: string[] = [];
  if (!overrides) return issues;
  const valveIds = new Set(system.edges.filter((e): e is ValveEdge => e.kind === 'valve').map((e) => e.id));
  for (const id of Object.keys(overrides)) {
    if (!valveIds.has(id)) issues.push(`valve state references unknown valve ${id}`);
  }
  return issues;
}

export function validateSteadyParams(system: VacuumSystem, params: SteadyParams | undefined): string[] {
  const issues = validateValveOverrides(system, params?.valveStates);
  if (params?.initialPressure !== undefined) {
    requirePositive(params.initialPressure, 'initialPressure', issues);
  }
  if (params?.maxIterations !== undefined) {
    if (!Number.isInteger(params.maxIterations) || params.maxIterations < 0) {
      issues.push('maxIterations must be a non-negative integer');
    }
  }
  if (params?.residualTolerance !== undefined) {
    requirePositive(params.residualTolerance, 'residualTolerance', issues);
  }
  return issues;
}

export function validateTransientParams(
  system: VacuumSystem,
  params: TransientParams | undefined
): string[] {
  const issues = validateValveOverrides(system, params?.valveStates);
  const p = params ?? {};
  if (p.initialPressure !== undefined) requirePositive(p.initialPressure, 'initialPressure', issues);
  if (p.initialPressures) {
    const nodeIds = new Set(system.nodes.map((n) => n.id));
    for (const [id, value] of Object.entries(p.initialPressures)) {
      if (!nodeIds.has(id)) issues.push(`initialPressures references unknown node ${id}`);
      else requirePositive(value, `initialPressures.${id}`, issues);
    }
  }
  const initialDefault = p.initialPressure ?? 1013.25;
  if (p.targetPressure !== undefined) {
    requirePositive(p.targetPressure, 'targetPressure', issues);
    if (p.targetPressure >= initialDefault) {
      issues.push('targetPressure must be lower than initialPressure');
    }
  }
  if (p.targets) {
    const nodeIds = new Set(system.nodes.map((n) => n.id));
    for (const [id, target] of Object.entries(p.targets)) {
      if (!nodeIds.has(id)) issues.push(`targets references unknown node ${id}`);
      else {
        requirePositive(target, `targets.${id}`, issues);
        const init = p.initialPressures?.[id] ?? initialDefault;
        if (target >= init) issues.push(`target for ${id} must be lower than its initial pressure`);
      }
    }
  }
  if (
    p.targetPressure === undefined &&
    (!p.targets || Object.keys(p.targets).length === 0)
  ) {
    issues.push('transient calculation requires targetPressure or targets');
  }
  for (const key of ['maxTime', 'initialStep', 'maxStep', 'minStep', 'residualTolerance'] as const) {
    if (p[key] !== undefined) requirePositive(p[key]!, key, issues);
  }
  if (p.maxIterations !== undefined && (!Number.isInteger(p.maxIterations) || p.maxIterations < 1)) {
    issues.push('maxIterations must be a positive integer');
  }
  if (p.initialStep && p.maxStep && p.initialStep > p.maxStep) {
    issues.push('initialStep must not exceed maxStep');
  }
  if (p.minStep && p.maxStep && p.minStep > p.maxStep) {
    issues.push('minStep must not exceed maxStep');
  }
  return issues;
}

export function assertNoValidationIssues(issues: string[]): void {
  if (issues.length > 0) throw new ValidationError(issues);
}
