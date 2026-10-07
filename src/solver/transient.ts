import type {
  PressurePoint,
  PumpSwitchEvent,
  TargetArrival,
  TransientParams,
  TransientResult,
  VacuumSystem,
  ChamberNode
} from '../types';
import { CancellationError, SolverError, ValidationError } from '../errors';
import {
  DEFAULT_INITIAL_PRESSURE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_STEP,
  DEFAULT_MIN_STEP,
  DEFAULT_RESIDUAL_TOLERANCE,
  DEFAULT_TRANSIENT_MAX_TIME,
  MAX_CURVE_POINTS
} from '../physics/constants';
import { prepareNetwork, reportGroupPressures, transientOutgassing, type PreparedNetwork } from './network';
import { solveLinear, normInf } from './linear';
import { tubeFlow, tubeFlowDerivatives } from '../physics/conductance';
import { pumpThroughput, pumpThroughputDerivative } from '../physics/pump';
import { solveSteady } from './steady';

const PRESSURE_FLOOR = 1e-30;
const MAX_LOG_STEP_CHANGE = 0.02;

export interface CancelToken {
  cancelled: boolean;
  check?: () => boolean;
}

export interface ProgressCallback {
  (progress: {
    time: number;
    acceptedSteps: number;
    rejectedSteps: number;
    iterations: number;
    finalResidual: number;
  }): void;
}

interface Evaluation {
  residual: number[];
  jacobian: number[][];
  scales: number[];
}

/** Algebraic balance at a physical state; used for junction initialization. */
function algebraicEvaluation(
  network: PreparedNetwork,
  p: number[],
  active: boolean[],
  time: number
): Evaluation {
  const n = network.groups.length;
  const residual: number[] = new Array<number>(n).fill(0);
  const scales: number[] = new Array<number>(n).fill(1e-12);
  const jacobian: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  network.groups.forEach((group, i) => {
    if (group.hasChamber) {
      const q = transientOutgassing(network, i, time);
      residual[i]! += q;
      scales[i] = Math.max(scales[i]!, Math.abs(q));
    }
  });

  for (const pipe of network.pipes) {
    const q = tubeFlow(pipe.model, p[pipe.i]!, p[pipe.j]!);
    const d = tubeFlowDerivatives(pipe.model, p[pipe.i]!, p[pipe.j]!);
    // Dynamic residual F = V dp/dt - sources + sinks. Positive tube flow is a
    // sink for i and a source for j.
    residual[pipe.i]! += q;
    residual[pipe.j]! -= q;
    jacobian[pipe.i]![pipe.i]! += d.dpi;
    jacobian[pipe.i]![pipe.j]! += d.dpj;
    jacobian[pipe.j]![pipe.i]! -= d.dpi;
    jacobian[pipe.j]![pipe.j]! -= d.dpj;
    scales[pipe.i] = Math.max(scales[pipe.i]!, Math.abs(q));
    scales[pipe.j] = Math.max(scales[pipe.j]!, Math.abs(q));
  }

  network.pumps.forEach((pump, k) => {
    if (!active[k]) return;
    const i = pump.group;
    const q = pumpThroughput(pump.model, p[i]!);
    residual[i]! += q;
    jacobian[i]![i]! += pumpThroughputDerivative(pump.model, p[i]!);
    scales[i] = Math.max(scales[i]!, Math.abs(q));
  });

  network.groups.forEach((group, i) => {
    if (!group.hasChamber && jacobian[i]!.every((value) => value === 0)) {
      residual[i]! = p[i]! - DEFAULT_INITIAL_PRESSURE;
      jacobian[i] = jacobian[i]!.map((value, j) => (j === i ? 1 : value));
      scales[i] = DEFAULT_INITIAL_PRESSURE;
    }
  });

  return { residual, jacobian, scales };
}

/**
 * Implicit-midpoint residual.
 *
 * Chambers have dynamic V*(p_new-p_old)/dt balances; junctions have algebraic
 * mass balances at midpoint. Both are solved simultaneously, so junction
 * pressures remain consistent inside every Newton iteration.
 */
function midpointEvaluation(
  network: PreparedNetwork,
  pOld: number[],
  pNew: number[],
  active: boolean[],
  tMid: number,
  dt: number
): Evaluation {
  const n = network.groups.length;
  const residual: number[] = new Array<number>(n).fill(0);
  const scales: number[] = new Array<number>(n).fill(1e-12);
  const jacobian: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const pMid = pNew.map((v, i) => 0.5 * (pOld[i]! + v));

  network.groups.forEach((group, i) => {
    if (!group.hasChamber) return;
    const volume = group.volume;
    const q = transientOutgassing(network, i, tMid);
    residual[i]! = volume * (pNew[i]! - pOld[i]!) / dt - q;
    jacobian[i]![i]! += volume / dt;
    scales[i] = Math.max(scales[i]!, Math.abs(volume * pNew[i]! / dt), Math.abs(q));
  });

  for (const pipe of network.pipes) {
    const q = tubeFlow(pipe.model, pMid[pipe.i]!, pMid[pipe.j]!);
    const d = tubeFlowDerivatives(pipe.model, pMid[pipe.i]!, pMid[pipe.j]!);
    // Same F = V dp/dt - outgassing + outflow convention as algebraic init.
    residual[pipe.i]! += q;
    residual[pipe.j]! -= q;
    jacobian[pipe.i]![pipe.i]! += 0.5 * d.dpi;
    jacobian[pipe.i]![pipe.j]! += 0.5 * d.dpj;
    jacobian[pipe.j]![pipe.i]! -= 0.5 * d.dpi;
    jacobian[pipe.j]![pipe.j]! -= 0.5 * d.dpj;
    scales[pipe.i] = Math.max(scales[pipe.i]!, Math.abs(q));
    scales[pipe.j] = Math.max(scales[pipe.j]!, Math.abs(q));
  }

  network.pumps.forEach((pump, k) => {
    if (!active[k]) return;
    const i = pump.group;
    const q = pumpThroughput(pump.model, pMid[i]!);
    residual[i]! += q;
    jacobian[i]![i]! += 0.5 * pumpThroughputDerivative(pump.model, pMid[i]!);
    scales[i] = Math.max(scales[i]!, Math.abs(q));
  });

  network.groups.forEach((group, i) => {
    if (!group.hasChamber) {
      const hasFlow = network.pipes.some((pipe) => pipe.i === i || pipe.j === i);
      const hasPump = network.pumps.some((pump, k) => active[k] && pump.group === i);
      if (!hasFlow && !hasPump) {
        residual[i]! = pNew[i]! - DEFAULT_INITIAL_PRESSURE;
        jacobian[i]![i]! += 1;
        scales[i] = Math.max(scales[i]!, DEFAULT_INITIAL_PRESSURE);
      }
    }
  });

  return { residual, jacobian, scales };
}

function scaledNorm(values: number[], scales: number[]): number {
  return normInf(values.map((v, i) => v / Math.max(scales[i]!, 1e-12)));
}

interface NewtonSolveResult {
  p: number[];
  iterations: number;
  residualNorm: number;
  rawResidual: number;
  converged: boolean;
}

function newtonMidpoint(
  network: PreparedNetwork,
  pOld: number[],
  pGuess: number[],
  active: boolean[],
  tMid: number,
  dt: number,
  tolerance: number,
  maxIterations: number
): NewtonSolveResult {
  let p = pGuess.map((v) => Math.max(PRESSURE_FLOOR, v));
  let ev = midpointEvaluation(network, pOld, p, active, tMid, dt);
  let residualNorm = scaledNorm(ev.residual, ev.scales);
  let rawResidual = normInf(ev.residual);
  if (residualNorm <= tolerance) return { p, iterations: 0, residualNorm, rawResidual, converged: true };

  for (let iterations = 1; iterations <= maxIterations; iterations++) {
    const delta = solveLinear(ev.jacobian, ev.residual.map((v) => -v));
    let lambda = 1;
    let accepted = false;
    let candidateEv: Evaluation | null = null;
    let candidate: number[] = [];

    for (let attempt = 0; attempt < 30; attempt++) {
      candidate = p.map((value, i) => {
        let d = delta[i]!;
        if (value + d < PRESSURE_FLOOR) d = value - PRESSURE_FLOOR;
        return Math.max(PRESSURE_FLOOR, value + lambda * d);
      });
      candidateEv = midpointEvaluation(network, pOld, candidate, active, tMid, dt);
      const candidateNorm = scaledNorm(candidateEv.residual, candidateEv.scales);
      if (Number.isFinite(candidateNorm) && candidateNorm <= residualNorm * (1 + 1e-4)) {
        accepted = true;
        break;
      }
      lambda *= 0.5;
    }

    if (!accepted || !candidateEv) {
      return { p, iterations, residualNorm, rawResidual, converged: false };
    }
    p = candidate;
    ev = candidateEv;
    residualNorm = scaledNorm(ev.residual, ev.scales);
    rawResidual = normInf(ev.residual);
    if (residualNorm <= tolerance) return { p, iterations, residualNorm, rawResidual, converged: true };
  }
  return { p, iterations: maxIterations, residualNorm, rawResidual, converged: false };
}

function initializeState(
  network: PreparedNetwork,
  chamberInitial: number[],
  initialCommon: number,
  tolerance: number,
  maxIterations: number
): { pressures: number[]; active: boolean[]; initialPumpSwitches: PumpSwitchEvent[] } {
  let active = network.pumps.map((pump) => initialCommon <= pump.startPressure);
  if (!active.some(Boolean)) {
    throw new SolverError(`no pump is permitted to start at initial pressure ${initialCommon} mbar`);
  }

  let p = network.groups.map((g, i) => (g.hasChamber ? chamberInitial[i]! : initialCommon));
  const switches: PumpSwitchEvent[] = [];
  const junctionIndices = network.groups.filter((g) => !g.hasChamber).map((g) => g.index);

  for (let round = 0; round < 30; round++) {
    if (junctionIndices.length > 0) {
      for (let iter = 0; iter < maxIterations; iter++) {
        const ev = algebraicEvaluation(network, p, active, 0);
        const reducedResidual = junctionIndices.map((i) => ev.residual[i]!);
        const scales = junctionIndices.map((i) => Math.max(ev.scales[i]!, 1e-12));
        const rn = normInf(reducedResidual.map((v, i) => v / scales[i]!));
        if (rn <= tolerance) break;
        const reducedJ = junctionIndices.map((i) => junctionIndices.map((j) => ev.jacobian[i]![j]!));
        const delta = solveLinear(reducedJ, reducedResidual.map((v) => -v));
        junctionIndices.forEach((i, k) => {
          p[i] = Math.max(PRESSURE_FLOOR, p[i]! + delta[k]!);
        });
      }
    }

    let changed = false;
    network.pumps.forEach((pump, k) => {
      if (!active[k] && p[pump.group]! <= pump.startPressure) {
        active[k] = true;
        changed = true;
        switches.push({
          time: 0,
          pumpId: pump.id,
          inletPressure: p[pump.group]!,
          reason: 'start-pressure-reached'
        });
      }
    });
    if (!changed) return { pressures: p, active, initialPumpSwitches: switches };
  }
  throw new SolverError('pump startup set did not stabilize during initial pressure calculation');
}

interface TargetState {
  group: number;
  chamberId: string;
  target: number;
  arrival: number | null;
}

function downsampleCurve(curve: PressurePoint[], maximum: number): PressurePoint[] {
  if (curve.length <= maximum) return curve;
  const lastIndex = curve.length - 1;
  const indices = new Set<number>([0, lastIndex]);
  for (let k = 1; k < maximum - 1; k++) {
    indices.add(Math.round((k * lastIndex) / (maximum - 1)));
  }
  return [...indices].sort((a, b) => a - b).map((i) => curve[i]!);
}

export interface TransientRunOptions {
  params?: TransientParams;
  cancelToken?: CancelToken;
  onProgress?: ProgressCallback;
}

export function runTransient(system: VacuumSystem, options: TransientRunOptions = {}): TransientResult {
  const params = options.params ?? {};
  const network = prepareNetwork(system, params.valveStates);
  const initialCommon = params.initialPressure ?? DEFAULT_INITIAL_PRESSURE;
  const tolerance = params.residualTolerance ?? DEFAULT_RESIDUAL_TOLERANCE;
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTime = params.maxTime ?? DEFAULT_TRANSIENT_MAX_TIME;
  const minStep = params.minStep ?? DEFAULT_MIN_STEP;
  const maxStep = params.maxStep ?? DEFAULT_MAX_STEP;
  let dt = Math.min(Math.max(params.initialStep ?? 1e-4, minStep), maxStep);

  const chamberInitial = new Array<number>(network.groups.length).fill(initialCommon);
  network.groups.forEach((group) => {
    if (!group.hasChamber) return;
    let pv = 0;
    let v = 0;
    for (const chamberId of group.chamberIds) {
      const chamber = system.nodes.find(
        (n): n is ChamberNode => n.id === chamberId && n.kind === 'chamber'
      );
      if (!chamber) continue;
      const p0 = params.initialPressures?.[chamberId] ?? initialCommon;
      pv += p0 * chamber.volume;
      v += chamber.volume;
    }
    chamberInitial[group.index] = pv / Math.max(v, Number.EPSILON);
  });

  const initialized = initializeState(network, chamberInitial, initialCommon, tolerance, maxIterations);
  let p = initialized.pressures;
  let active = initialized.active;
  let t = 0;

  const ultimate = solveSteady(network, {
    initialPressure: initialCommon,
    maxIterations,
    residualTolerance: tolerance
  });

  const targets: TargetState[] = [];
  network.groups.forEach((group) => {
    for (const chamberId of group.chamberIds) {
      const per = params.targets?.[chamberId];
      if (per !== undefined) targets.push({ group: group.index, chamberId, target: per, arrival: null });
      else if (params.targetPressure !== undefined) {
        targets.push({ group: group.index, chamberId, target: params.targetPressure, arrival: null });
      }
    }
  });
  if (targets.length === 0) throw new ValidationError(['transient calculation requires a target pressure']);
  for (const target of targets) {
    const limit = ultimate.pressures.find((x) => x.nodeId === target.chamberId)?.pressure ?? 0;
    if (target.target < limit * (1 - 1e-6)) {
      throw new ValidationError([
        `target ${target.target} mbar for chamber ${target.chamberId} is below calculated ultimate pressure ${limit.toExponential(3)} mbar`
      ]);
    }
  }

  const pumpSwitches: PumpSwitchEvent[] = [...initialized.initialPumpSwitches];
  const curve: PressurePoint[] = [{ time: 0, pressures: reportGroupPressures(network, p) }];
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let iterations = 0;
  let finalResidual = 0;
  let stopReason: TransientResult['stopReason'] = 'max-time';
  let finished = false;

  const throwIfCancelled = () => {
    if (options.cancelToken?.cancelled || options.cancelToken?.check?.()) throw new CancellationError();
  };

  const activatePumpsAt = (pressures: number[], time: number) => {
    network.pumps.forEach((pump, k) => {
      if (!active[k] && pressures[pump.group]! <= pump.startPressure) {
        active[k] = true;
        pumpSwitches.push({
          time,
          pumpId: pump.id,
          inletPressure: pressures[pump.group]!,
          reason: 'start-pressure-reached'
        });
      }
    });
  };

  const earliestTrigger = (pressures: number[]): boolean => {
    const pump = network.pumps.some((pump, k) => !active[k] && pressures[pump.group]! <= pump.startPressure);
    const target = targets.some((x) => x.arrival === null && pressures[x.group]! <= x.target);
    return pump || target;
  };

  const applyTriggers = (pressures: number[], time: number) => {
    activatePumpsAt(pressures, time);
    targets.forEach((target) => {
      if (target.arrival === null && pressures[target.group]! <= target.target) target.arrival = time;
    });
  };

  while (t < maxTime) {
    throwIfCancelled();
    dt = Math.min(dt, maxTime - t, maxStep);
    const step = newtonMidpoint(
      network,
      p,
      p,
      active,
      t + 0.5 * dt,
      dt,
      tolerance,
      maxIterations
    );

    if (!step.converged) {
      rejectedSteps++;
      finalResidual = step.residualNorm;
      dt *= 0.5;
      if (dt < minStep) {
        stopReason = 'solver-failure';
        break;
      }
      continue;
    }

    const logChange = normInf(
      network.chamberGroups.map((i) =>
        Math.abs(Math.log(Math.max(step.p[i]!, PRESSURE_FLOOR) / Math.max(p[i]!, PRESSURE_FLOOR)))
      )
    );
    if (logChange > MAX_LOG_STEP_CHANGE && dt > minStep * 1.0001) {
      rejectedSteps++;
      const desired = dt * Math.max(0.1, Math.min(0.9, 0.9 * MAX_LOG_STEP_CHANGE / Math.max(logChange, 1e-12)));
      dt = Math.max(minStep, desired);
      continue;
    }

    let newTime = t + dt;
    let newP = step.p;
    iterations += step.iterations;
    finalResidual = step.residualNorm;

    if (earliestTrigger(newP)) {
      // Bisect this step to the first pressure threshold crossing.
      let lo = t;
      let hi = newTime;
      let pHi = newP;
      for (let b = 0; b < 30; b++) {
        const midTime = 0.5 * (lo + hi);
        const mid = newtonMidpoint(network, p, p, active, t + 0.5 * (midTime - t), midTime - t, tolerance, maxIterations);
        if (!mid.converged) {
          hi = midTime;
          pHi = mid.p;
        } else if (earliestTrigger(mid.p)) {
          hi = midTime;
          pHi = mid.p;
        } else {
          lo = midTime;
        }
      }
      newTime = hi;
      newP = pHi;
      dt = Math.max(minStep, newTime - t);
    }

    t = newTime;
    p = newP;
    acceptedSteps++;
    applyTriggers(p, t);
    curve.push({ time: t, pressures: reportGroupPressures(network, p) });
    options.onProgress?.({ time: t, acceptedSteps, rejectedSteps, iterations, finalResidual });

    if (targets.every((target) => target.arrival !== null)) {
      stopReason = 'targets-reached';
      finished = true;
      break;
    }

    if (logChange < 0.005) dt = Math.min(maxStep, Math.max(minStep, dt * 1.5));
    else dt = Math.min(maxStep, Math.max(minStep, dt * 1.1));
  }

  applyTriggers(p, t);
  const targetArrivals: TargetArrival[] = targets.map((target) => ({
    nodeId: target.chamberId,
    target: target.target,
    time: target.arrival,
    pressure: p[target.group]!
  }));

  return {
    curve: downsampleCurve(curve, MAX_CURVE_POINTS),
    targetArrivals,
    pumpSwitches,
    activePumpsAtEnd: network.pumps.filter((_, k) => active[k]).map((pump) => pump.id),
    finalTime: t,
    finalPressures: reportGroupPressures(network, p),
    iterations,
    acceptedSteps,
    rejectedSteps,
    finalResidual,
    rawResidual: finalResidual,
    residualTolerance: tolerance,
    converged: stopReason !== 'solver-failure',
    finished,
    stopReason,
    ultimatePressureCheck: ultimate.pressures
  };
}
