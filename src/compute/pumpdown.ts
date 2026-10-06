import type {
  ConvergenceReport,
  CurvePoint,
  PumpdownResult,
  PumpSwitchEvent,
  SystemVersion,
  TargetHit,
  ValveState
} from '../types';
import { assemble, buildNetwork } from '../physics/network';
import { outgassingAt } from '../physics/outgassing';
import { newtonSolve, residualMetrics, type CancellationToken } from '../numeric/newton';

/**
 * Pump-down integration.
 *
 * The network is a differential-algebraic system:
 *   chambers:  V_i dP_i/dt = q_out,i(t) - outflow_i
 *   junctions: 0 = outflow_i - q_out,i
 * where outflow_i = sum C_ij (P_i - P_j) + S_i P_i is the throughput leaving
 * node i. With F_i = outflow_i - extIn_i (extIn = outgassing), the equations
 * are dP_i/dt = -F_i/V_i for chambers and F_i = 0 for junctions.
 *
 * At every Runge-Kutta stage the junction pressures are solved implicitly
 * (Newton, warm started from the previous stage), while the chamber pressures
 * advance with an embedded Dormand-Prince 5(4) adaptive step.
 *
 * Discrete events (pump crossover switching and target-pressure crossing)
 * are located by bisection with Hermite interpolation for the chamber
 * pressures and a Newton re-solve for the junctions, so reported event times
 * are far more accurate than one time step.
 */

// Dormand-Prince 5(4) nodes and coefficients.
const DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const DP_A: number[][] = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]
];
const DP_B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const DP_B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

export interface PumpdownOptions {
  initialPressureMbar: number;
  target?: { pressureMbar: number; chamberIds?: string[] };
  maxTimeS?: number;
  valveStates?: ValveState;
  maxIterations?: number;
  tolerance?: number;
  relTol?: number;
  absTol?: number;
  maxStepS?: number;
  initialPressures?: Record<string, number>;
  token?: CancellationToken;
}

interface StageEval {
  t: number;
  P: number[]; // full network pressure vector
  dy: number[]; // chamber derivatives, chamber-list order
  active: boolean[];
  iterations: number;
  residualNorm: number;
  converged: boolean;
}

export async function runPumpdown(version: SystemVersion, opts: PumpdownOptions): Promise<PumpdownResult> {
  const net = buildNetwork(version, opts.valveStates ?? {});
  const nCh = net.chamberNodeIds.length;
  const chamberIndices = net.chamberNodeIds.map((id) => net.nodeIndex.get(id)!);
  const junctionFixed = net.nodes.map((n) => n.kind === 'chamber');
  const hasJunction = net.nodes.some((n) => n.kind === 'junction');

  const maxIterations = opts.maxIterations ?? 100000;
  const tolerance = opts.tolerance ?? 1e-9;
  const relTol = opts.relTol ?? 1e-8;
  const absTol = opts.absTol ?? 1e-12;
  const maxStep = opts.maxStepS ?? 5;
  const maxTime = opts.maxTimeS ?? 3.6e6; // default horizon 1000 h
  const targetChambers = opts.target?.chamberIds ?? net.chamberNodeIds.slice();
  const targetSet = new Set(targetChambers);
  const targetP = opts.target?.pressureMbar ?? NaN;
  const stageBudget = Math.max(60, Math.floor(maxIterations / 4) + 1);

  let t = 0;
  // Chambers always start from initialPressureMbar; initialPressures is only
  // allowed to warm-start junction guesses.
  let y = chamberIndices.map(() => opts.initialPressureMbar);
  let junctionGuess = net.nodes.map((n) =>
    n.kind === 'junction' ? opts.initialPressures?.[n.id] ?? opts.initialPressureMbar : opts.initialPressureMbar
  );

  let totalSolves = 0;
  let solveIterations = 0;
  let rejectedSteps = 0;
  let acceptedSteps = 0;
  let failedStageSolves = 0;
  let maxStageResidual = 0;

  const pumpEvents: PumpSwitchEvent[] = [];
  const targetHits: TargetHit[] = [];
  const targetTimeById: Record<string, number | null> = {};
  for (const id of net.chamberNodeIds) targetTimeById[id] = null;
  const curve: CurvePoint[] = [];

  /**
   * Pumps whose start gate is being held on a chosen branch after a discrete
   * switch. The hold is released once the inlet is clearly inside the gate
   * band's fully-on side (p ≤ pstart − 3δ), at which point the smooth gate and
   * the held gate agree exactly, so the release is continuous.
   */
  const forcedGates = new Map<number, boolean>();

  const extInAt = (tt: number): number[] =>
    net.nodes.map((nd) => (nd.kind === 'chamber' ? outgassingAt(nd.outgassing, tt) : 0));

  function fullPressure(yv: number[], guess: number[]): number[] {
    const P = guess.slice();
    for (let k = 0; k < nCh; k++) P[chamberIndices[k]] = yv[k];
    return P;
  }

  function releaseRelaxedForces(P: number[]): void {
    for (const [k, on] of forcedGates) {
      const pk = net.pumps[k];
      const pStart = pk.model.startPressureMbar;
      const delta = Math.max(1e-4 * pStart, 1e-12);
      if (on && P[pk.nodeIndex] <= pStart - 3 * delta) {
        forcedGates.delete(k);
      } else if (!on && P[pk.nodeIndex] >= pStart + 3 * delta) {
        forcedGates.delete(k);
      }
    }
  }

  /** Solve junction pressures at (tt, yv); compute chamber derivatives. */
  async function solveAt(tt: number, yv: number[], guess: number[]): Promise<StageEval> {
    const Pguess = fullPressure(yv, guess);
    const extIn = extInAt(tt);
    let P = Pguess;
    let active: boolean[];
    let iterations = 0;
    let converged = true;
    let residualNorm = 0;
    if (hasJunction) {
      // Junction solve warm-started from the previous stage for temporal
      // continuity. When the warm start fails to converge (typically exactly at
      // a pump gate kink), probe guesses on both sides of every unforced
      // crossover near the current iterate and take the converged solution with
      // the smallest residual. After a detected switch the relevant pump is
      // held by forcedGates, so normal continuation always follows the newly
      // active branch without a branch-selection ambiguity.
      const run = async (g0: number[]) =>
        newtonSolve(net, {
          initialP: g0,
          fixed: junctionFixed,
          extIn,
          maxIterations: stageBudget,
          tolerance,
          forcePumpGate: forcedGates,
          token: opts.token
        });

      const primary = await run(Pguess);
      let chosen = primary;
      if (!primary.convergence.converged) {
        const alts: Awaited<ReturnType<typeof run>>[] = [];
        for (let k = 0; k < net.pumps.length; k++) {
          if (forcedGates.has(k)) continue;
          const inlet = net.pumps[k].nodeIndex;
          if (junctionFixed[inlet]) continue;
          const pStart = net.pumps[k].model.startPressureMbar;
          for (const factor of [0.5, 1 - 2e-3, 1 + 2e-3]) {
            const g = Pguess.slice();
            g[inlet] = Math.max(1e-30, pStart * factor);
            const sol = await run(g);
            if (sol.convergence.converged) alts.push(sol);
          }
        }
        if (alts.length > 0) {
          chosen = alts.reduce((a, b) =>
            b.convergence.finalResidual < a.convergence.finalResidual ? b : a
          );
        }
      }
      P = chosen.P;
      active = chosen.activePumps;
      iterations = chosen.convergence.iterations;
      converged = chosen.convergence.converged;
      residualNorm = chosen.convergence.finalResidual;
    } else {
      active = net.pumps.map((pk, k) =>
        forcedGates.has(k) ? forcedGates.get(k)! : pk.model.isActive(Pguess[pk.nodeIndex])
      );
    }
    releaseRelaxedForces(P);
    // dP/dt = -F/V for chambers (F = outflow - extIn).
    const { F } = assemble(net, P, extIn, forcedGates.size ? forcedGates : undefined);
    const dyv = new Array<number>(nCh).fill(0);
    for (let k = 0; k < nCh; k++) {
      dyv[k] = -F[chamberIndices[k]] / net.nodes[chamberIndices[k]].volumeL;
    }
    if (residualNorm > maxStageResidual) maxStageResidual = residualNorm;
    return { t: tt, P, dy: dyv, active, iterations, residualNorm, converged };
  }

  function recordCurve(tt: number, st: StageEval): void {
    const pressuresMbar: Record<string, number> = {};
    for (const id of net.chamberNodeIds) pressuresMbar[id] = st.P[net.nodeIndex.get(id)!];
    curve.push({
      timeS: tt,
      pressuresMbar,
      activePumps: net.pumps.filter((_, k) => st.active[k]).map((pk) => pk.model.id)
    });
  }

  function allTargetsReached(): boolean {
    if (!opts.target) return false;
    return targetChambers.every((cid) => targetTimeById[cid] !== null);
  }

  // ---- Initial state -------------------------------------------------------
  let stage0 = await solveAt(0, y, junctionGuess);
  totalSolves++;
  solveIterations += stage0.iterations;
  junctionGuess = stage0.P;
  recordCurve(0, stage0);
  if (!stage0.converged) {
    const m0 = residualMetrics(net, stage0.P, extInAt(0), junctionFixed);
    return finalize('line_search_failed', m0.normalised, m0.physicalMbarLps);
  }

  let h = Math.min(1e-6, maxStep, maxTime);
  let stopReason: ConvergenceReport['stopReason'] = 'time_limit';

  mainLoop: while (t < maxTime) {
    if (opts.token?.cancelled) {
      stopReason = 'failed';
      break;
    }
    if (solveIterations >= maxIterations) {
      stopReason = 'max_iterations';
      break;
    }
    // Yield to the event loop each outer integration step. Pump-down runs are
    // I/O-independent but must stay responsive to cancellation requests.
    await new Promise((r) => setImmediate(r));
    if (opts.token?.cancelled) {
      stopReason = 'failed';
      break;
    }
    if (h > maxTime - t) h = maxTime - t;

    // ---- Dormand-Prince stages --------------------------------------------
    const stages: StageEval[] = [stage0];
    let stepFailed = false;

    for (let s = 1; s <= 6; s++) {
      const ys = y.slice();
      for (let k = 0; k < nCh; k++) {
        let acc = 0;
        for (let j = 0; j < s; j++) acc += DP_A[s][j] * stages[j].dy[k];
        ys[k] = y[k] + h * acc;
        if (!(ys[k] > 0) || !Number.isFinite(ys[k])) ys[k] = 1e-30;
      }
      const st = await solveAt(t + DP_C[s] * h, ys, stages[s - 1].P);
      totalSolves++;
      solveIterations += st.iterations;
      if (!st.converged) {
        failedStageSolves++;
        rejectedSteps++;
        h *= 0.2;
        stepFailed = true;
        if (h < 1e-15) {
          stopReason = 'line_search_failed';
          break mainLoop;
        }
        break;
      }
      stages.push(st);
    }
    if (stepFailed) continue;

    // ---- embedded estimates -----------------------------------------------
    const y5 = y.slice();
    const y4 = y.slice();
    for (let k = 0; k < nCh; k++) {
      let acc5 = 0;
      let acc4 = 0;
      for (let s = 0; s < 7; s++) {
        acc5 += DP_B5[s] * stages[s].dy[k];
        acc4 += DP_B4[s] * stages[s].dy[k];
      }
      y5[k] = y[k] + h * acc5;
      y4[k] = y[k] + h * acc4;
    }

    let err2 = 0;
    for (let k = 0; k < nCh; k++) {
      const scale = absTol + relTol * Math.max(Math.abs(y[k]), Math.abs(y5[k]));
      const e = (y5[k] - y4[k]) / scale;
      err2 += e * e;
    }
    const err = Math.sqrt(err2 / Math.max(nCh, 1));

    if (err > 1 && h > 1e-12) {
      rejectedSteps++;
      h *= Math.max(0.1, 0.9 * Math.pow(err, -0.2));
      continue;
    }

    const tEnd = t + h;
    const stageEnd = stages[6];

    // ---- events inside (t, tEnd] ------------------------------------------
    // (a) pump switches: scan all stages for activity changes (catches
    //     intra-step crossings, not just endpoint mismatches).
    let tEvent: number | null = null;
    type EventKind = 'switch' | 'target';
    let eventKind: EventKind | null = null;
    let switchPump = -1;
    let switchActive = false;
    let targetK = -1;

    for (let k = 0; k < net.pumps.length; k++) {
      // A pump held on a post-switch branch does not generate further events
      // until its hold is released well inside the new regime.
      if (forcedGates.has(k)) continue;
      for (let s = 1; s <= 6; s++) {
        if (stages[s].active[k] !== stages[s - 1].active[k]) {
          // Bisection between the two stage times (monotonic pump-down makes
          // the crossover unique while the current activity set is frozen).
          const tA = t + DP_C[s - 1] * h;
          const tB = t + DP_C[s] * h;
          let lo = tA;
          let hi = tB;
          let stHi = stages[s];
          for (let it = 0; it < 24; it++) {
            const mid = (lo + hi) / 2;
            const yvMid = chamberHermite(t, y, stage0, tEnd, y5, stageEnd, mid);
            const stm = await solveAt(mid, yvMid, stHi.P);
            totalSolves++;
            solveIterations += stm.iterations;
            if (stm.active[k] === stages[s - 1].active[k]) lo = mid;
            else {
              hi = mid;
              stHi = stm;
            }
          }
          if (tEvent === null || hi < tEvent) {
            tEvent = hi;
            eventKind = 'switch';
            switchPump = k;
            switchActive = stHi.active[k];
          }
          break; // earliest interval for this pump only
        }
      }
    }

    // (b) target crossings.
    if (opts.target) {
      for (let k = 0; k < nCh; k++) {
        if (!targetSet.has(net.chamberNodeIds[k])) continue;
        if (targetTimeById[net.chamberNodeIds[k]] !== null) continue;
        // Earliest stage at which the target bracket is crossed.
        let sEnd = -1;
        for (let s = 1; s <= 6; s++) {
          const pPrev = stages[s - 1].P[chamberIndices[k]];
          const pNow = stages[s].P[chamberIndices[k]];
          if (pPrev > targetP && pNow <= targetP) {
            sEnd = s;
            break;
          }
        }
        if (sEnd >= 0) {
          const tA = t + DP_C[sEnd - 1] * h;
          const tB = t + DP_C[sEnd] * h;
          const pA = stages[sEnd - 1].P[chamberIndices[k]];
          const vA = stages[sEnd - 1].dy[k];
          const pB = stages[sEnd].P[chamberIndices[k]];
          const vB = stages[sEnd].dy[k];
          let lo = tA;
          let hi = tB;
          for (let it = 0; it < 30; it++) {
            const mid = (lo + hi) / 2;
            if (hermite(tA, pA, vA, tB, pB, vB, mid) > targetP) lo = mid;
            else hi = mid;
          }
          if (tEvent === null || hi < tEvent) {
            tEvent = hi;
            eventKind = 'target';
            targetK = k;
          }
        }
      }
    }

    if (tEvent !== null) {
      const yvEvent = chamberHermite(t, y, stage0, tEnd, y5, stageEnd, tEvent);

      // After a pump switch, hold the pump on the branch it just entered before
      // re-solving the junctions. Without this the smooth gate band admits the
      // old algebraic branch as a second solution and warm continuation gets
      // stuck there; the hold is released in solveAt once the inlet is clearly
      // inside the new regime (a continuous release, since g ≡ 1 there).
      if (eventKind === 'switch') {
        forcedGates.set(switchPump, switchActive);
      }
      let stEvent = await solveAt(tEvent, yvEvent, stageEnd.P);
      totalSolves++;
      solveIterations += stEvent.iterations;

      acceptedSteps++;
      t = tEvent;
      y = yvEvent;
      junctionGuess = stEvent.P;
      recordCurve(t, stEvent);

      if (eventKind === 'target') {
        const cid = net.chamberNodeIds[targetK];
        targetHits.push({ timeS: t, chamberId: cid, pressureMbar: y[targetK] });
        targetTimeById[cid] = t;
      }
      if (eventKind === 'switch') {
        const pk = net.pumps[switchPump];
        pumpEvents.push({
          timeS: t,
          pumpId: pk.model.id,
          active: switchActive,
          inletPressureMbar: stEvent.P[pk.nodeIndex]
        });
      }

      stage0 = stEvent;
      h = Math.min(maxStep, Math.max(h * 0.5, 1e-12));
      if (allTargetsReached()) {
        stopReason = 'target_reached';
        break;
      }
      continue;
    }

    // ---- plain accepted step ----------------------------------------------
    t = tEnd;
    y = y5;
    junctionGuess = stageEnd.P;
    acceptedSteps++;
    recordCurve(t, stageEnd);
    stage0 = stageEnd;

    if (allTargetsReached()) {
      stopReason = 'target_reached';
      break;
    }
    if (err <= 1) h = Math.min(maxStep, h * (err === 0 ? 4 : Math.min(5, 0.9 * Math.pow(err, -0.2))));
  }

  const lastStage = await solveAt(t, y, junctionGuess);
  totalSolves++;
  solveIterations += lastStage.iterations;
  if (!lastStage.converged && stopReason !== 'failed' && stopReason !== 'target_reached') {
    stopReason = 'line_search_failed';
  }
  const metrics = residualMetrics(net, lastStage.P, extInAt(t), junctionFixed);

  // The reported final residual describes the final state itself. A rejected
  // probe during an earlier trial step must not contaminate it (its maximum is
  // tracked separately for diagnostics via failedStageSolves).
  return finalize(stopReason, metrics.normalised, metrics.physicalMbarLps);

  function finalize(
    reason: ConvergenceReport['stopReason'],
    finalResidual: number,
    finalPhys: number
  ): PumpdownResult {
    const allT = opts.target
      ? targetChambers.every((cid) => targetTimeById[cid] !== null)
      : false;
    const hitTimes = targetChambers.map((cid) => targetTimeById[cid]).filter((v): v is number => v !== null);
    const overallTarget = allT ? Math.max(...hitTimes) : null;
    const finalPressuresMbar: Record<string, number> = {};
    for (let k = 0; k < nCh; k++) finalPressuresMbar[net.chamberNodeIds[k]] = y[k];

    const convergence: ConvergenceReport = {
      converged: reason === 'target_reached' || reason === 'time_limit',
      stopReason: reason,
      iterations: solveIterations,
      maxIterations,
      tolerance,
      finalResidual,
      finalResidualMbarLps: finalPhys,
      totalNonlinearSolves: totalSolves,
      rejectedSteps,
      acceptedSteps,
      failedStageSolves
    };

    return {
      kind: 'pumpdown',
      initialPressureMbar: opts.initialPressureMbar,
      finalTimeS: t,
      finalPressuresMbar,
      targetTimesS: { ...targetTimeById },
      targetTimeS: overallTarget,
      allTargetsReached: allT,
      pumpEvents,
      targetHits,
      curve: downsample(curve),
      convergence
    };
  }
}

// ---- interpolation helpers -------------------------------------------------

function hermite(t0: number, p0: number, v0: number, t1: number, p1: number, v1: number, t: number): number {
  const h = t1 - t0;
  if (h === 0) return p0;
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
}

function chamberHermite(
  t0: number,
  y0: number[],
  st0: StageEval,
  t1: number,
  y1: number[],
  st1: StageEval,
  t: number
): number[] {
  const yv = y0.map((p0, k) => hermite(t0, p0, st0.dy[k], t1, y1[k], st1.dy[k], t));
  for (let k = 0; k < yv.length; k++) if (!(yv[k] > 0)) yv[k] = 1e-30;
  return yv;
}

function downsample(curve: CurvePoint[]): CurvePoint[] {
  const MAX = 4000;
  if (curve.length <= MAX) return curve;
  const stride = (curve.length - 1) / (MAX - 1);
  const out: CurvePoint[] = [];
  for (let i = 0; i < MAX; i++) {
    const idx = Math.min(curve.length - 1, Math.round(i * stride));
    const pt = curve[idx];
    if (out.length === 0 || out[out.length - 1].timeS !== pt.timeS) out.push(pt);
  }
  return out;
}
