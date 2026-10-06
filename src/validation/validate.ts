import type {
  JobRequest,
  NodeInput,
  OutgassingModel,
  PumpEdgeInput,
  SystemVersionInput,
  ValveState
} from '../types';

/** Validation failure with a flat list of human readable problems. */
export class ValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`validation failed: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

const VALID_GASES = new Set(['air', 'N2', 'O2', 'H2', 'He', 'Ar', 'Ne', 'CO2', 'water_vapor']);

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkOutgassing(model: OutgassingModel | undefined, nodeId: string, issues: string[]): void {
  if (!model) return;
  const fail = (msg: string) => issues.push(`node ${nodeId}: ${msg}`);
  switch (model.type) {
    case 'constant':
      if (!isFiniteNum(model.q)) fail('constant outgassing rate must be a finite number');
      else if (model.q < 0) fail('outgassing rate must not be negative');
      break;
    case 'power':
      if (!isFiniteNum(model.q100) || model.q100 < 0) fail('q100 must be a non-negative number');
      if (!isFiniteNum(model.alpha) || model.alpha < 0) fail('alpha must be a non-negative number');
      break;
    case 'exponential':
      if (!isFiniteNum(model.q0) || model.q0 < 0) fail('q0 must be a non-negative number');
      if (!isFiniteNum(model.qInf) || model.qInf < 0) fail('qInf must be a non-negative number');
      if (!isFiniteNum(model.tau) || model.tau <= 0) fail('tau must be a positive number');
      break;
    case 'rational':
      if (!isFiniteNum(model.q0) || model.q0 < 0) fail('q0 must be a non-negative number');
      if (!isFiniteNum(model.tau) || model.tau <= 0) fail('tau must be a positive number');
      break;
    default:
      fail(`unknown outgassing model type: ${(model as { type: string }).type}`);
  }
}

/**
 * Structural validation of a system description. Returns the complete list of
 * problems rather than throwing on the first one, as required ("指出问题").
 */
export function validateSystem(input: SystemVersionInput): string[] {
  const issues: string[] = [];

  if (!input || typeof input !== 'object') {
    return ['request body must be a system description object'];
  }
  if (!VALID_GASES.has(input.gas)) issues.push(`unsupported gas species: ${String(input.gas)}`);
  if (!isFiniteNum(input.temperatureK) || input.temperatureK <= 0) {
    issues.push('temperatureK must be a positive number');
  }
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    issues.push('network must contain at least one node');
    return issues;
  }
  if (!Array.isArray(input.edges)) {
    issues.push('edges must be an array');
    return issues;
  }

  const nodeIds = new Set<string>();
  for (const nodeRaw of input.nodes) {
    const node = nodeRaw as NodeInput;
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      issues.push('every node needs a non-empty string id');
      continue;
    }
    if (nodeIds.has(node.id)) issues.push(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    if (node.kind === 'chamber') {
      if (!isFiniteNum(node.volumeL) || node.volumeL <= 0) {
        issues.push(`chamber ${node.id}: volumeL must be a positive number`);
      }
      checkOutgassing(node.outgassing, node.id, issues);
    } else if (node.kind === 'junction') {
      // ok
    } else {
      const unknownNode = node as unknown as { id?: string; kind?: string };
      issues.push(`node ${String(unknownNode.id)}: unknown kind ${String(unknownNode.kind)}`);
    }
  }

  const edgeIds = new Set<string>();
  const valveIds = new Set<string>();
  for (const edgeRaw of input.edges) {
    const edge = edgeRaw as (typeof input.edges)[number];
    if (!edge || typeof edge.id !== 'string' || edge.id.length === 0) {
      issues.push('every edge needs a non-empty string id');
      continue;
    }
    if (edgeIds.has(edge.id)) issues.push(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);

    if (edge.kind === 'pipe') {
      if (!nodeIds.has(edge.from)) issues.push(`pipe ${edge.id}: unknown endpoint node ${edge.from}`);
      if (!nodeIds.has(edge.to)) issues.push(`pipe ${edge.id}: unknown endpoint node ${edge.to}`);
      if (!isFiniteNum(edge.innerDiameterMm) || edge.innerDiameterMm <= 0) {
        issues.push(`pipe ${edge.id}: innerDiameterMm must be a positive number`);
      }
      if (!isFiniteNum(edge.lengthM) || edge.lengthM <= 0) {
        issues.push(`pipe ${edge.id}: lengthM must be a positive number`);
      }
      if (edge.from === edge.to && nodeIds.has(edge.from)) {
        issues.push(`pipe ${edge.id}: self connection on node ${edge.from}`);
      }
    } else if (edge.kind === 'valve') {
      valveIds.add(edge.id);
      if (!nodeIds.has(edge.from)) issues.push(`valve ${edge.id}: unknown endpoint node ${edge.from}`);
      if (!nodeIds.has(edge.to)) issues.push(`valve ${edge.id}: unknown endpoint node ${edge.to}`);
      if (edge.openConductanceLps !== undefined) {
        if (!isFiniteNum(edge.openConductanceLps) || edge.openConductanceLps <= 0) {
          issues.push(`valve ${edge.id}: openConductanceLps must be positive when provided`);
        }
      }
      if (edge.from === edge.to && nodeIds.has(edge.from)) {
        issues.push(`valve ${edge.id}: self connection on node ${edge.from}`);
      }
    } else if (edge.kind === 'pump') {
      if (!nodeIds.has(edge.node)) issues.push(`pump ${edge.id}: unknown inlet node ${edge.node}`);
      checkPump(edge, issues);
    } else {
      const unknownEdge = edge as unknown as { id?: string; kind?: string };
      issues.push(`edge ${String(unknownEdge.id)}: unknown kind ${String(unknownEdge.kind)}`);
    }
  }

  return issues;
}

function checkPump(edge: PumpEdgeInput, issues: string[]): void {
  if (!Array.isArray(edge.speedTable) || edge.speedTable.length < 1) {
    issues.push(`pump ${edge.id}: speedTable must contain at least one point`);
    return;
  }
  if (!isFiniteNum(edge.startPressureMbar) || edge.startPressureMbar < 0) {
    issues.push(`pump ${edge.id}: startPressureMbar must be a non-negative number`);
  }
  for (let i = 0; i < edge.speedTable.length; i++) {
    const pt = edge.speedTable[i];
    if (!isFiniteNum(pt.pressureMbar) || pt.pressureMbar < 0) {
      issues.push(`pump ${edge.id}: speedTable[${i}].pressureMbar must be non-negative`);
    }
    if (!isFiniteNum(pt.speedLps) || pt.speedLps < 0) {
      issues.push(`pump ${edge.id}: speedTable[${i}].speedLps must be non-negative`);
    }
    // Monotonicity is checked independently of the value checks above so an
    // invalid speed entry never masks an out-of-order pressure table.
    if (i > 0) {
      const prev = edge.speedTable[i - 1].pressureMbar;
      if (isFiniteNum(prev) && isFiniteNum(pt.pressureMbar) && pt.pressureMbar <= prev) {
        issues.push(`pump ${edge.id}: speedTable pressure points must be strictly increasing (index ${i})`);
      }
    }
  }
}

/** Undirected connectivity: which chamber nodes can reach some pump via open edges. */
export function chambersWithoutPumpPath(
  input: SystemVersionInput,
  valveStates: ValveState = {}
): string[] {
  const adj = new Map<string, string[]>();
  const nodeIds = new Set(input.nodes.map((n) => n.id));
  for (const id of nodeIds) adj.set(id, []);
  const pumpedNodes = new Set<string>();

  for (const edge of input.edges) {
    if (edge.kind === 'pump') {
      pumpedNodes.add(edge.node);
    } else {
      const open = edge.kind === 'pipe' || (valveStates[edge.id] ?? edge.initiallyOpen ?? true);
      if (!open) continue;
      adj.get(edge.from)?.push(edge.to);
      adj.get(edge.to)?.push(edge.from);
    }
  }

  const reachable = new Set<string>();
  const stack = [...pumpedNodes];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id) || !nodeIds.has(id)) continue;
    reachable.add(id);
    for (const nb of adj.get(id) ?? []) stack.push(nb);
  }

  return input.nodes.filter((n) => n.kind === 'chamber' && !reachable.has(n.id)).map((n) => n.id);
}

export function assertValidSystem(input: SystemVersionInput): void {
  const issues = validateSystem(input);
  if (issues.length) throw new ValidationError(issues);
}

/**
 * Job level validation: valve references, target vs initial pressure,
 * tolerance ranges, and (important) the open-path connectivity requirement.
 */
export function validateJob(input: SystemVersionInput, req: JobRequest): string[] {
  const issues: string[] = [];
  const valveIds = new Set(input.edges.filter((e) => e.kind === 'valve').map((e) => e.id));
  const valveStates = req.valveStates ?? {};

  for (const id of Object.keys(valveStates)) {
    if (!valveIds.has(id)) issues.push(`valve state references unknown valve: ${id}`);
  }

  if (req.maxIterations !== undefined && (!Number.isInteger(req.maxIterations) || req.maxIterations <= 0)) {
    issues.push('maxIterations must be a positive integer');
  }
  if (req.tolerance !== undefined && (!(req.tolerance > 0) || !Number.isFinite(req.tolerance))) {
    issues.push('tolerance must be a positive number');
  }

  const orphan = chambersWithoutPumpPath(input, valveStates);
  if (orphan.length) {
    issues.push(`chambers without any open path to a pump: ${orphan.join(', ')}`);
  }

  if (req.kind === 'pumpdown') {
    if (!isFiniteNum(req.initialPressureMbar) || req.initialPressureMbar <= 0) {
      issues.push('initialPressureMbar must be a positive number');
    }
    if (req.maxTimeS !== undefined && (!(req.maxTimeS > 0) || !Number.isFinite(req.maxTimeS))) {
      issues.push('maxTimeS must be a positive number when provided');
    }
    if (req.relTol !== undefined && !(req.relTol > 0)) issues.push('relTol must be positive');
    if (req.absTol !== undefined && !(req.absTol > 0)) issues.push('absTol must be positive');
    if (req.maxStepS !== undefined && !(req.maxStepS > 0)) issues.push('maxStepS must be positive');
    if (req.target) {
      if (!isFiniteNum(req.target.pressureMbar) || req.target.pressureMbar <= 0) {
        issues.push('target.pressureMbar must be a positive number');
      } else if (
        isFiniteNum(req.initialPressureMbar) &&
        req.target.pressureMbar >= req.initialPressureMbar
      ) {
        issues.push('target pressure must be strictly below initial pressure');
      }
      if (req.target.chamberIds) {
        for (const cid of req.target.chamberIds) {
          const node = input.nodes.find((n) => n.id === cid);
          if (!node) issues.push(`target references unknown chamber: ${cid}`);
          else if (node.kind !== 'chamber') issues.push(`target node is not a chamber: ${cid}`);
        }
      }
    }
  }

  return issues;
}

export function assertValidJob(input: SystemVersionInput, req: JobRequest): void {
  const issues = validateJob(input, req);
  if (issues.length) throw new ValidationError(issues);
}
