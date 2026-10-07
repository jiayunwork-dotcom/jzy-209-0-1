import type { PreparedNetwork } from './network';
import { pumpThroughput, pumpThroughputDerivative } from '../physics/pump';
import { tubeFlow, tubeFlowDerivatives } from '../physics/conductance';
import { solveLinear, normInf } from './linear';
import type { NodePressure, SteadyResult } from '../types';
import {
  DEFAULT_INITIAL_PRESSURE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RESIDUAL_TOLERANCE
} from '../physics/constants';
import { reportGroupPressures } from './network';

export interface SteadyOptions {
  initialPressure?: number;
  maxIterations?: number;
  residualTolerance?: number;
  initialGuess?: number[];
  forceActivePumps?: boolean[];
}

const PRESSURE_FLOOR = 1e-30;
const MAX_LINE_SEARCH = 80;

interface Evaluation {
  residual: number[];
  jacobian: number[][];
  /** Current characteristic throughput magnitude at each node. */
  flowScales: number[];
}

export function evaluateSteady(
  network: PreparedNetwork,
  p: number[],
  active: boolean[]
): Evaluation {
  const n = network.groups.length;
  const residual: number[] = new Array<number>(n).fill(0);
  const flowScales: number[] = new Array<number>(n).fill(1e-30);
  const jacobian: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (const group of network.groups) {
    residual[group.index] = residual[group.index]! + group.constantOutgassing;
    flowScales[group.index] = Math.max(
      flowScales[group.index]!,
      Math.abs(group.constantOutgassing)
    );
  }

  for (const pipe of network.pipes) {
    const { i, j } = pipe;
    const q = tubeFlow(pipe.model, p[i]!, p[j]!);
    const d = tubeFlowDerivatives(pipe.model, p[i]!, p[j]!);
    // Residual convention: inflows - outflows = 0. Positive tube flow leaves i.
    residual[i]! -= q;
    residual[j]! += q;
    jacobian[i]![i]! -= d.dpi;
    jacobian[i]![j]! -= d.dpj;
    jacobian[j]![i]! += d.dpi;
    jacobian[j]![j]! += d.dpj;
    const aq = Math.abs(q);
    flowScales[i] = Math.max(flowScales[i]!, aq);
    flowScales[j] = Math.max(flowScales[j]!, aq);
  }

  network.pumps.forEach((pump, k) => {
    if (!active[k]) return;
    const i = pump.group;
    const q = pumpThroughput(pump.model, p[i]!);
    residual[i]! -= q;
    jacobian[i]![i]! -= pumpThroughputDerivative(pump.model, p[i]!);
    flowScales[i] = Math.max(flowScales[i]!, Math.abs(q));
  });

  // Regularize massless nodes that are not incident to any active flow element.
  // Their pressure is physically undetermined; fixing it at a nominal value
  // keeps the Jacobian non-singular without affecting any chamber result.
  network.groups.forEach((group, i) => {
    if (!group.hasChamber && jacobian[i]!.every((value) => value === 0)) {
      residual[i]! = p[i]! - DEFAULT_INITIAL_PRESSURE;
      jacobian[i] = jacobian[i]!.map((value, j) => (j === i ? 1 : value));
      flowScales[i] = DEFAULT_INITIAL_PRESSURE;
    }
  });

  return { residual, jacobian, flowScales };
}

function scaledNorm(residual: number[], scales: number[]): number {
  return normInf(residual.map((v, i) => v / scales[i]!));
}

interface NewtonState {
  pressures: number[];
  residual: number[];
  jacobian: number[][];
  /**
   * Persistent per-node throughput scales: the running maximum characteristic
   * flow seen at each node. Freezing the historical maximum (instead of scaling
   * by the current flow, which vanishes at the solution) keeps the line search
   * able to reject a step that fixes a dominant node while wrecking another.
   */
  scales: number[];
  iterations: number;
  residualNorm: number;
  rawResidual: number;
  converged: boolean;
}

function makeState(
  network: PreparedNetwork,
  pressures: number[],
  active: boolean[],
  scales: number[],
  iterations: number,
  tolerance: number
): NewtonState {
  const ev = evaluateSteady(network, pressures, active);
  const mergedScales = scales.map((s, i) => Math.max(s, ev.flowScales[i]!));
    const residualNorm = scaledNorm(ev.residual, mergedScales);
  return {
    pressures,
    residual: ev.residual,
    jacobian: ev.jacobian,
    scales: mergedScales,
    iterations,
    residualNorm,
    rawResidual: normInf(ev.residual),
    converged: residualNorm <= tolerance
  };
}

function newtonStep(
  network: PreparedNetwork,
  state: NewtonState,
  active: boolean[],
  maxIterations: number,
  tolerance: number
): NewtonState {
  if (state.iterations >= maxIterations) return state;
  const delta = solveLinear(state.jacobian, state.residual.map((v) => -v));

  // Damped Newton; positivity is ensured by shrinking any pressure decrease.
  let lambda = 1;
  for (let attempt = 0; attempt < MAX_LINE_SEARCH; attempt++) {
    const candidate = state.pressures.map((value, i) => {
      const step = lambda * delta[i]!;
      if (step < 0 && -step >= value) return value * 1e-6;
      return value + step;
    });
    const ev = evaluateSteady(network, candidate, active);
    const candidateNorm = scaledNorm(ev.residual, state.scales);
    if (Number.isFinite(candidateNorm) && candidateNorm <= state.residualNorm * (1 - 1e-8 * lambda) + 1e-30) {
      const iterations = state.iterations + 1;
      const scales = state.scales.map((s, i) => Math.max(s, ev.flowScales[i]!));
      return {
        pressures: candidate,
        residual: ev.residual,
        jacobian: ev.jacobian,
        scales,
        iterations,
        residualNorm: scaledNorm(ev.residual, scales),
        rawResidual: normInf(ev.residual),
        converged: candidateNorm <= tolerance || iterations >= maxIterations
      };
    }
    lambda *= 0.5;
    if (lambda < 1e-12) break;
  }

  return {
    ...state,
    iterations: state.iterations + 1,
    converged: state.iterations + 1 >= maxIterations
  };
}

function buildResult(
  network: PreparedNetwork,
  active: boolean[],
  state: NewtonState,
  maxIterations: number,
  tolerance: number
): SteadyResult {
  const pressures: NodePressure[] = reportGroupPressures(network, state.pressures);
  return {
    pressures,
    pumps: network.pumps.map((pump, k) => ({
      pumpId: pump.id,
      active: active[k]!,
      inletPressure: state.pressures[pump.group]!
    })),
    mergedGroups: network.groups.map((g) => g.memberIds),
    iterations: state.iterations,
    maxIterations,
    finalResidual: state.residualNorm,
    rawResidual: state.rawResidual,
    residualTolerance: tolerance,
    converged: state.converged && state.residualNorm <= tolerance,
    activePumps: network.pumps.filter((_, k) => active[k]).map((pump) => pump.id)
  };
}

export function solveSteady(network: PreparedNetwork, options: SteadyOptions = {}): SteadyResult {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = options.residualTolerance ?? DEFAULT_RESIDUAL_TOLERANCE;
  const startPressure = options.initialPressure ?? DEFAULT_INITIAL_PRESSURE;
  const n = network.groups.length;

  // Steady state represents the asymptotic network equilibrium, so every pump
  // is included in the equations. Startup interlocks affect transient access
  // timing, not the final achievable pressure.
  const active: boolean[] = options.forceActivePumps
    ? [...options.forceActivePumps]
    : network.pumps.map(() => true);

  const initialGuess =
    options.initialGuess && options.initialGuess.length === n
      ? options.initialGuess
      : new Array<number>(n).fill(startPressure);
  const initialScales = new Array<number>(n).fill(1e-30);
  // Seed every node scale with its outgassing load, so a node fed only by a tiny
  // leak is never judged against a dominant pump flow elsewhere.
  network.groups.forEach((g, i) => {
    initialScales[i] = Math.max(initialScales[i]!, Math.abs(g.constantOutgassing));
  });
  let state = makeState(network, initialGuess, active, initialScales, 0, tolerance);
  while (state.iterations < maxIterations && state.residualNorm > tolerance) {
    state = newtonStep(network, state, active, maxIterations, tolerance);
  }
  return buildResult(network, active, state, maxIterations, tolerance);
}
