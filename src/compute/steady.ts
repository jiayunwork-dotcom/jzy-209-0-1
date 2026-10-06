import type {
  ConvergenceReport,
  EdgeSteadyReport,
  SteadyResult,
  SystemVersion,
  ValveState
} from '../types';
import { buildNetwork, edgeFlow, pumpThroughput } from '../physics/network';
import { steadyOutgassing } from '../physics/outgassing';
import { newtonSolve, type CancellationToken } from '../numeric/newton';

export interface SteadyOptions {
  valveStates?: ValveState;
  maxIterations?: number;
  tolerance?: number;
  /** nodeId -> initial pressure (hot start). */
  initialPressures?: Record<string, number>;
  token?: CancellationToken;
}

export async function runSteady(version: SystemVersion, opts: SteadyOptions = {}): Promise<SteadyResult> {
  const net = buildNetwork(version, opts.valveStates ?? {});
  const maxIterations = opts.maxIterations ?? 60;
  const tolerance = opts.tolerance ?? 1e-9;

  const extIn = net.nodes.map((n) => (n.kind === 'chamber' ? steadyOutgassing(n.outgassing) : 0));

  const initialP = net.nodes.map((n) => opts.initialPressures?.[n.id] ?? 1e-4);

  let convergence: ConvergenceReport;
  let P: number[];
  let active: boolean[];

  if (net.pumps.length === 0) {
    P = initialP;
    convergence = {
      converged: false,
      stopReason: 'no_pumps',
      iterations: 0,
      maxIterations,
      tolerance,
      finalResidual: NaN,
      finalResidualMbarLps: NaN
    };
    active = [];
  } else {
    const sol = await newtonSolve(net, {
      initialP,
      extIn,
      maxIterations,
      tolerance,
      token: opts.token
    });
    P = sol.P;
    active = sol.activePumps;
    convergence = {
      converged: sol.convergence.converged,
      stopReason: sol.convergence.stopReason,
      iterations: sol.convergence.iterations,
      maxIterations,
      tolerance,
      finalResidual: sol.convergence.finalResidual,
      finalResidualMbarLps: sol.convergence.finalResidualMbarLps
    };
  }

  const pressuresMbar: Record<string, number> = {};
  const chamberPressuresMbar: Record<string, number> = {};
  const outgassingMbarLps: Record<string, number> = {};
  for (const n of net.nodes) {
    pressuresMbar[n.id] = P[n.index];
    if (n.kind === 'chamber') {
      chamberPressuresMbar[n.id] = P[n.index];
      outgassingMbarLps[n.id] = steadyOutgassing(n.outgassing);
    }
  }

  const edges: EdgeSteadyReport[] = [];
  for (const e of net.concEdges) {
    const f = edgeFlow(e, P);
    edges.push({
      edgeId: e.id,
      kind: e.kind,
      from: e.aId,
      to: e.bId,
      throughputMbarLps: f.q,
      meanPressureMbar: f.meanP,
      conductanceLps: f.c,
      molecularConductanceLps: f.cMol,
      viscousConductanceLps: f.cVis,
      regime: f.regime
    });
  }
  for (let k = 0; k < net.pumps.length; k++) {
    const pk = net.pumps[k];
    const r = pumpThroughput(pk, P[pk.nodeIndex]);
    edges.push({
      edgeId: pk.model.id,
      kind: 'pump',
      from: net.nodes[pk.nodeIndex].id,
      to: null,
      throughputMbarLps: r.q,
      meanPressureMbar: P[pk.nodeIndex],
      speedLps: r.speed,
      active: r.active
    });
  }

  const activePumps = net.pumps.filter((_, k) => active[k]).map((pk) => pk.model.id);

  return {
    kind: 'steady',
    pressuresMbar,
    chamberPressuresMbar,
    limitingPressureMbar: { ...chamberPressuresMbar },
    edges,
    activePumps,
    convergence,
    outgassingMbarLps
  };
}
