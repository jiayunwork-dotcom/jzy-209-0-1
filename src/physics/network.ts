import type {
  GasSpecies,
  NodeInput,
  OutgassingModel,
  SystemVersionInput,
  ValveState
} from '../types';
import { dynamicViscosity, meanFreePath } from './gas';
import {
  pipeMolecularConductanceLps,
  regimeFromKnudsen
} from './conductance';
import type { FlowRegime } from '../types';
import { PumpModel } from './pump';

export interface NetNode {
  id: string;
  kind: 'chamber' | 'junction';
  index: number;
  volumeL: number; // 0 for junctions
  outgassing?: OutgassingModel;
}

interface ConcEdge {
  id: string;
  kind: 'pipe' | 'valve';
  a: number;
  b: number;
  aId: string;
  bId: string;
  // molecular part, L/s (0 for ideal-ish valves still stores explicit value)
  cMol: number;
  // viscous part = kVis * (p_a + p_b) / 2, L/s; kVis in L/(s mbar); 0 for valves
  kVis: number;
  diameterM?: number;
  lengthM?: number;
  species?: GasSpecies;
  temperatureK?: number;
}

interface NetPump {
  model: PumpModel;
  nodeIndex: number;
}

export interface BuiltNetwork {
  species: GasSpecies;
  temperatureK: number;
  nodes: NetNode[];
  nodeIndex: Map<string, number>;
  concEdges: ConcEdge[];
  pumps: NetPump[];
  chamberNodeIds: string[];
}

/**
 * Build the numerical network from a system version and a valve state map.
 * Closed valves are removed (zero conductance); unlisted valves default open.
 */
export function buildNetwork(system: SystemVersionInput, valveStates: ValveState = {}): BuiltNetwork {
  const nodeIndex = new Map<string, number>();
  const nodes: NetNode[] = system.nodes.map((n: NodeInput, i) => {
    nodeIndex.set(n.id, i);
    if (n.kind === 'chamber') {
      return { id: n.id, kind: 'chamber' as const, index: i, volumeL: n.volumeL, outgassing: n.outgassing };
    }
    return { id: n.id, kind: 'junction' as const, index: i, volumeL: 0 };
  });

  const eta = dynamicViscosity(system.gas, system.temperatureK);
  const concEdges: ConcEdge[] = [];
  const pumps: NetPump[] = [];

  for (const edge of system.edges) {
    if (edge.kind === 'pump') {
      pumps.push({ model: new PumpModel(edge), nodeIndex: mustNode(nodeIndex, edge.node, edge.id) });
      continue;
    }
    if (edge.kind === 'valve') {
      const open = valveStates[edge.id] ?? edge.initiallyOpen ?? true;
      if (!open) continue;
      const a = mustNode(nodeIndex, edge.from, edge.id);
      const b = mustNode(nodeIndex, edge.to, edge.id);
      concEdges.push({
        id: edge.id,
        kind: 'valve',
        a,
        b,
        aId: edge.from,
        bId: edge.to,
        cMol: edge.openConductanceLps ?? 1e9,
        kVis: 0
      });
      continue;
    }
    // pipe
    const a = mustNode(nodeIndex, edge.from, edge.id);
    const b = mustNode(nodeIndex, edge.to, edge.id);
    const dM = edge.innerDiameterMm / 1000;
    const cMol = pipeMolecularConductanceLps(dM, edge.lengthM, system.gas, system.temperatureK);
    // C_visc = pi d^4 * 2 pMean(Pa) / (256 eta L) * 1000 L/m^3
    //        = [pi d^4 * 200 * 1000 / (256 eta L)] * pMean(mbar)
    const kVis = (Math.PI * dM ** 4 * 200 * 1000) / (256 * eta * edge.lengthM);
    concEdges.push({
      id: edge.id,
      kind: 'pipe',
      a,
      b,
      aId: edge.from,
      bId: edge.to,
      cMol,
      kVis,
      diameterM: dM,
      lengthM: edge.lengthM,
      species: system.gas,
      temperatureK: system.temperatureK
    });
  }

  return {
    species: system.gas,
    temperatureK: system.temperatureK,
    nodes,
    nodeIndex,
    concEdges,
    pumps,
    chamberNodeIds: nodes.filter((n) => n.kind === 'chamber').map((n) => n.id)
  };
}

function mustNode(map: Map<string, number>, id: string, edgeId: string): number {
  const i = map.get(id);
  if (i === undefined) throw new Error(`edge ${edgeId} references unknown node ${id}`);
  return i;
}

/** Conductance split for a conductance edge at a given pressure vector. */
export function edgeConductance(e: ConcEdge, P: number[]): { c: number; cMol: number; cVis: number; meanP: number } {
  if (e.kind === 'valve') return { c: e.cMol, cMol: e.cMol, cVis: 0, meanP: (P[e.a] + P[e.b]) / 2 };
  const meanP = (P[e.a] + P[e.b]) / 2;
  const cVis = e.kVis * meanP;
  return { c: e.cMol + cVis, cMol: e.cMol, cVis, meanP };
}

export function edgeFlow(e: ConcEdge, P: number[]): {
  q: number; // throughput a -> b, mbar L/s
  c: number;
  cMol: number;
  cVis: number;
  meanP: number;
  dq_dpa: number;
  dq_dpb: number;
  regime: FlowRegime;
  kn: number;
} {
  const { c, cMol, cVis, meanP } = edgeConductance(e, P);
  const dp = P[e.a] - P[e.b];
  const q = c * dp;
  if (e.kind === 'valve') {
    return { q, c, cMol, cVis, meanP, dq_dpa: c, dq_dpb: -c, regime: 'viscous', kn: 0 };
  }
  const dq_dpa = c + (e.kVis / 2) * dp;
  const dq_dpb = -c + (e.kVis / 2) * dp;
  const lambda = meanFreePath(e.species!, e.temperatureK!, Math.max(meanP, 1e-20));
  const kn = lambda / e.diameterM!;
  return { q, c, cMol, cVis, meanP, dq_dpa, dq_dpb, regime: regimeFromKnudsen(kn), kn };
}

/**
 * Evaluate a pump at its inlet.
 * Physical throughput: Q = g(p)·S(p)·p, where g is the narrow smooth start
 * gate used by the numerical path (see PumpModel.gateFactor). The reported
 * `active` flag uses the strict crossover (p ≤ startPressure).
 */
export function pumpThroughput(p: NetPump, inletP: number): {
  q: number;
  speed: number;
  active: boolean;
  dq_dp: number;
} {
  const active = p.model.isActive(inletP);
  const { g, dg } = p.model.gateFactor(inletP);
  if (g === 0) return { q: 0, speed: 0, active, dq_dp: 0 };
  const eff = p.model.effectiveAt(inletP);
  const speed = g * eff.speed;
  // dQ/dp = dg/dp·S·p + g·(S + p·dS/dp)
  const dq_dp = dg * eff.speed * inletP + g * (eff.speed + inletP * eff.dSpeed);
  return { q: speed * inletP, speed, active, dq_dp };
}

/**
 * Assemble residual F and Jacobian J of the node balance equations.
 *
 * Convention: F_i = (net throughput LEAVING node i to neighbours and pumps)
 *                      - external inflow extIn[i]
 * and a steady solution satisfies F(P) = 0.
 *
 * extIn[i] is q_outgassing - V_i dP_i/dt (the latter only in dynamic runs).
 */
export function assemble(
  net: BuiltNetwork,
  P: number[],
  extIn: number[],
  forcePumpGate?: Map<number, boolean>
): { F: number[]; J: number[][]; activePumps: boolean[] } {
  const n = net.nodes.length;
  const F = new Array<number>(n).fill(0);
  const J: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (const e of net.concEdges) {
    const f = edgeFlow(e, P);
    // Flow leaves a towards b.
    F[e.a] += f.q;
    F[e.b] -= f.q;
    J[e.a][e.a] += f.dq_dpa;
    J[e.a][e.b] += f.dq_dpb;
    J[e.b][e.a] -= f.dq_dpa;
    J[e.b][e.b] -= f.dq_dpb;
  }

  const activePumps: boolean[] = [];
  for (let k = 0; k < net.pumps.length; k++) {
    const pk = net.pumps[k];
    const i = pk.nodeIndex;
    const forced = forcePumpGate?.get(k);
    const r = forced === undefined
      ? pumpThroughput(pk, P[i])
      : forced
        ? forcedOnThroughput(pk, P[i])
        : { q: 0, speed: 0, active: false, dq_dp: 0 };
    activePumps.push(r.active);
    F[i] += r.q;
    J[i][i] += r.dq_dp;
  }

  for (let i = 0; i < n; i++) F[i] -= extIn[i];
  return { F, J, activePumps };
}

/** Throughput with the pump forced fully on, ignoring the start gate. */
function forcedOnThroughput(p: NetPump, inletP: number): {
  q: number;
  speed: number;
  active: boolean;
  dq_dp: number;
} {
  const eff = p.model.effectiveAt(inletP);
  // At a forced-on point the gate is held at g ≡ 1 (no gate derivative).
  return {
    q: eff.speed * inletP,
    speed: eff.speed,
    active: true,
    dq_dp: eff.speed + inletP * eff.dSpeed
  };
}
