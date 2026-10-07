import type {
  ChamberNode,
  GasSpecies,
  PumpEdge,
  SystemNode,
  VacuumSystem,
  ValveEdge
} from '../types';
import { createPumpModel, type PumpModel } from '../physics/pump';
import { createTubeModel, type TubeModel } from '../physics/conductance';
import { valveIsOpen, chambersWithoutPumpPath } from '../physics/validation';
import { outgassingAt, outgassingAtSteady } from '../physics/outgassing';
import { DEFAULT_TEMPERATURE } from '../physics/gas';
import { ValidationError } from '../errors';

export interface SuperNode {
  index: number;
  memberIds: string[];
  chamberIds: string[];
  junctionIds: string[];
  volume: number;
  representativeId: string;
  /** Initial outgassing specs aggregated by algebraically summing rates. */
  constantOutgassing: number;
  transientOutgassingRate0: number;
  // Aggregated dynamic specs are represented as a sum evaluator below.
  hasChamber: boolean;
}

export interface PreparedPipe {
  id: string;
  i: number;
  j: number;
  model: TubeModel;
}

export interface PreparedPump {
  id: string;
  group: number;
  model: PumpModel;
  startPressure: number;
}

export interface PreparedNetwork {
  system: VacuumSystem;
  gas: GasSpecies;
  temperature: number;
  groups: SuperNode[];
  nodeToGroup: Map<string, number>;
  pipes: PreparedPipe[];
  pumps: PreparedPump[];
  chamberGroups: number[];
  /** Adjacency over only currently open paths, used for diagnostics. */
  adjacency: Map<number, number[]>;
}

interface UnionFind {
  parent: Map<string, string>;
}

function createUnionFind(ids: string[]): UnionFind {
  const parent = new Map<string, string>();
  ids.forEach((id) => parent.set(id, id));
  return { parent };
}

function find(uf: UnionFind, x: string): string {
  let root = x;
  while (uf.parent.get(root) !== root) root = uf.parent.get(root)!;
  let cur = x;
  while (uf.parent.get(cur) !== cur) {
    const next = uf.parent.get(cur)!;
    uf.parent.set(cur, root);
    cur = next;
  }
  return root;
}

function union(uf: UnionFind, a: string, b: string): void {
  const ra = find(uf, a);
  const rb = find(uf, b);
  if (ra !== rb) uf.parent.set(rb, ra);
}

function sumOutgassingAt(chambers: ChamberNode[], time: number | 'steady'): number {
  return chambers.reduce((sum, chamber) => {
    const q = chamber.outgassing;
    return sum + (time === 'steady' ? outgassingAtSteady(q) : outgassingAt(q, time));
  }, 0);
}

export function prepareNetwork(
  system: VacuumSystem,
  valveStates?: Record<string, boolean>
): PreparedNetwork {
  const nodeIds = new Set(system.nodes.map((n) => n.id));
  const uf = createUnionFind(system.nodes.map((n) => n.id));

  // Open ideal valves merge their endpoint supernodes.
  for (const edge of system.edges) {
    if (edge.kind === 'valve' && valveIsOpen(edge as ValveEdge, valveStates)) {
      union(uf, edge.a, edge.b);
    }
  }

  const rootToMembers = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(uf, id);
    rootToMembers.set(root, [...(rootToMembers.get(root) ?? []), id]);
  }

  const roots = [...rootToMembers.keys()].sort();
  const nodeToGroup = new Map<string, number>();
  const groups: SuperNode[] = roots.map((root, index) => {
    const memberIds = (rootToMembers.get(root) ?? []).slice().sort();
    const chambers = system.nodes.filter(
      (n): n is ChamberNode => n.kind === 'chamber' && memberIds.includes(n.id)
    );
    memberIds.forEach((id) => nodeToGroup.set(id, index));
    const junctions = memberIds.filter(
      (id) => system.nodes.find((n) => n.id === id)?.kind === 'junction'
    );
    const chamberIds = chambers.map((c) => c.id);
    return {
      index,
      memberIds,
      chamberIds,
      junctionIds: junctions,
      volume: chambers.reduce((sum, c) => sum + c.volume, 0),
      representativeId: chamberIds[0] ?? memberIds[0]!,
      constantOutgassing: sumOutgassingAt(chambers, 'steady'),
      transientOutgassingRate0: sumOutgassingAt(chambers, 0),
      hasChamber: chambers.length > 0
    };
  });

  const pipes: PreparedPipe[] = [];
  const adjacency = new Map<number, Set<number>>();
  const gas: GasSpecies = system.gas ?? 'air';
  const temperature = system.temperature ?? DEFAULT_TEMPERATURE;

  for (const edge of system.edges) {
    if (edge.kind !== 'pipe') continue;
    const i = nodeToGroup.get(edge.a)!;
    const j = nodeToGroup.get(edge.b)!;
    if (i === j) continue;
    pipes.push({
      id: edge.id,
      i,
      j,
      model: createTubeModel(edge.diameter, edge.length, gas, temperature)
    });
    if (!adjacency.has(i)) adjacency.set(i, new Set());
    if (!adjacency.has(j)) adjacency.set(j, new Set());
    adjacency.get(i)!.add(j);
    adjacency.get(j)!.add(i);
  }

  // Open valves also remain ordinary graph links for reachability diagnostics.
  for (const edge of system.edges) {
    if (edge.kind === 'valve' && valveIsOpen(edge, valveStates)) {
      const i = nodeToGroup.get(edge.a)!;
      const j = nodeToGroup.get(edge.b)!;
      if (i !== j) {
        if (!adjacency.has(i)) adjacency.set(i, new Set());
        if (!adjacency.has(j)) adjacency.set(j, new Set());
        adjacency.get(i)!.add(j);
        adjacency.get(j)!.add(i);
      }
    }
  }

  const pumps: PreparedPump[] = [];
  const pumpInlets = new Set<string>();
  for (const edge of system.edges) {
    if (edge.kind === 'pump') {
      const pump = edge as PumpEdge;
      pumps.push({
        id: pump.id,
        group: nodeToGroup.get(pump.from)!,
        model: createPumpModel(pump.curve, pump.startPressure),
        startPressure: pump.startPressure ?? Number.POSITIVE_INFINITY
      });
      pumpInlets.add(pump.from);
      if (!adjacency.has(nodeToGroup.get(pump.from)!)) {
        adjacency.set(nodeToGroup.get(pump.from)!, new Set());
      }
    }
  }

  const chamberIds = new Set(
    system.nodes.filter((n): n is SystemNode => n.kind === 'chamber').map((n) => n.id)
  );
  const ordinaryAdj = new Map<string, string[]>();
  for (const edge of system.edges) {
    if (edge.kind === 'pipe') {
      ordinaryAdj.set(edge.a, [...(ordinaryAdj.get(edge.a) ?? []), edge.b]);
      ordinaryAdj.set(edge.b, [...(ordinaryAdj.get(edge.b) ?? []), edge.a]);
    } else if (edge.kind === 'valve' && valveIsOpen(edge, valveStates)) {
      ordinaryAdj.set(edge.a, [...(ordinaryAdj.get(edge.a) ?? []), edge.b]);
      ordinaryAdj.set(edge.b, [...(ordinaryAdj.get(edge.b) ?? []), edge.a]);
    }
  }
  const disconnected = chambersWithoutPumpPath(chamberIds, pumpInlets, ordinaryAdj);
  if (disconnected.length > 0) {
    throw new ValidationError([
      `with the requested valve state, chambers have no path to a pump: ${disconnected.join(', ')}`
    ]);
  }

  const chamberGroups = groups.map((g, i) => (g.hasChamber ? i : -1)).filter((i) => i >= 0);
  return {
    system,
    gas,
    temperature,
    groups,
    nodeToGroup,
    pipes,
    pumps,
    chamberGroups,
    adjacency: new Map([...adjacency.entries()].map(([k, v]) => [k, [...v].sort()]))
  };
}

export function transientOutgassing(network: PreparedNetwork, groupIndex: number, time: number): number {
  const group = network.groups[groupIndex]!;
  const chambers = network.system.nodes.filter(
    (n): n is ChamberNode => n.kind === 'chamber' && group.chamberIds.includes(n.id)
  );
  return sumOutgassingAt(chambers, time);
}

export function reportGroupPressures(
  network: PreparedNetwork,
  pressures: number[]
): Array<{ nodeId: string; pressure: number }> {
  return network.groups.flatMap((group) =>
    group.memberIds.map((nodeId) => ({ nodeId, pressure: pressures[group.index]! }))
  );
}
