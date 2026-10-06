import { assemble, type BuiltNetwork } from '../physics/network';
import { solveLinear } from './linalg';
import type { ConvergenceReport } from '../types';
import { SingularMatrixError } from './linalg';

export interface CancellationToken {
  cancelled: boolean;
}

export interface NewtonOptions {
  /** Initial iterate (mbar). Defaults to 1e-4 mbar cold start. */
  initialP?: number[];
  /** Node indices whose pressure is held fixed (chambers during dynamic runs). */
  fixed?: boolean[];
  maxIterations: number;
  tolerance: number;
  /** External inflow per node, mbar L/s (outgassing - V dP/dt). */
  extIn: number[];
  /**
   * Pump indices forced to a specific gate state, regardless of inlet
   * pressure. Used immediately after a discrete switch event so the algebraic
   * solve follows the branch the integrator just entered.
   */
  forcePumpGate?: Map<number, boolean>;
  token?: CancellationToken;
}

export interface NewtonResult {
  P: number[];
  convergence: Pick<
    ConvergenceReport,
    'converged' | 'stopReason' | 'iterations' | 'maxIterations' | 'tolerance' | 'finalResidual' | 'finalResidualMbarLps'
  >;
  activePumps: boolean[];
}

// Zero is a legitimate pressure (the exact steady solution with no
// outgassing). Newton iterates are clamped to be non-negative rather than to a
// tiny positive floor: clamping both ends of an edge to the same positive floor
// would kill its delta-p and leave a spurious pump throughput at the floor.
const P_FLOOR = 0;
const SCALE_FLOOR = 1e-40; // mbar L/s residual scale floor
/** Absolute physical-residual convergence floor, mbar L/s (handles the true zero solution with no outgassing). */
const PHYS_RESIDUAL_FLOOR = 1e-22;

/**
 * Convergence requires the per-node normalised residual to be small. The one
 * exception is the zero-load case (no outgassing): when every throughput tends
 * to zero the normalisation scale is dominated by the residual itself, so the
 * normalised measure stalls near 1 even though the physical node imbalance is
 * vanishing; there an absolute physical residual floor identifies p → 0.
 */
function isConverged(normalised: number, physical: number, tolerance: number): boolean {
  return normalised <= tolerance || physical <= PHYS_RESIDUAL_FLOOR;
}

/**
 * Newton-Raphson solution of the network node balances.
 *
 *  - The residual at node i is normalised by the total throughput magnitude
 *    handled at that node, so the same tolerance is meaningful from viscous
 *    flow at 1000 mbar down to molecular flow at 1e-8 mbar.
 *  - A backtracking line search (half steps, positivity enforced) keeps the
 *    iterates physical even when the cold start guess is far from the answer.
 *  - Pump start gates make the residual piecewise defined; activity is
 *    re-evaluated from the current iterate each step (no inner fixed-point).
 */
export async function newtonSolve(net: BuiltNetwork, opts: NewtonOptions): Promise<NewtonResult> {
  const n = net.nodes.length;
  const fixed = opts.fixed ?? new Array<boolean>(n).fill(false);
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!fixed[i]) free.push(i);

  const P = opts.initialP
    ? opts.initialP.slice()
    : net.nodes.map(() => 1e-4);

  if (free.length === 0) {
    const metrics = residualMetrics(net, P, opts.extIn, fixed);
    const ok = isConverged(metrics.normalised, metrics.physicalMbarLps, opts.tolerance);
    return {
      P,
      convergence: {
        converged: ok,
        stopReason: ok ? 'tolerance_reached' : 'max_iterations',
        iterations: 0,
        maxIterations: opts.maxIterations,
        tolerance: opts.tolerance,
        finalResidual: metrics.normalised,
        finalResidualMbarLps: metrics.physicalMbarLps
      },
      activePumps: net.pumps.map((pk) => pk.model.isActive(P[pk.nodeIndex]))
    };
  }

  let { F, J, activePumps } = assemble(net, P, opts.extIn, opts.forcePumpGate);
  let scales = computeScales(net, P, opts.extIn, activePumps);
  let merit = freeMerit(F, scales, free);
  let iter = 0;
  let norm = freeNorm(F, scales, free);
  let phys = freePhys(F, free);

  if (isConverged(norm, phys, opts.tolerance)) {
    return result(P, norm, phys, 'tolerance_reached', 0, opts, activePumps);
  }

  let stopReason: ConvergenceReport['stopReason'] = 'max_iterations';

  while (iter < opts.maxIterations) {
    if (opts.token?.cancelled) {
      stopReason = 'failed';
      break;
    }
    // Yield to the event loop periodically so that a long steady-state solve
    // remains responsive to HTTP requests (job status, cancellation).
    if (iter > 0 && iter % 5 === 0) {
      await new Promise((r) => setImmediate(r));
      if (opts.token?.cancelled) {
        stopReason = 'failed';
        break;
      }
    }

    // Reduced Jacobian for free nodes.
    const m = free.length;
    const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const rhs: number[] = new Array<number>(m);
    for (let r = 0; r < m; r++) {
      const i = free[r];
      rhs[r] = -F[i];
      for (let c = 0; c < m; c++) A[r][c] = J[i][free[c]];
    }

    let dy: number[];
    try {
      dy = solveLinear(A, rhs);
    } catch (e) {
      if (e instanceof SingularMatrixError) {
        stopReason = 'singular_matrix';
        break;
      }
      throw e;
    }

    // Backtracking line search on the normalised merit.
    let alpha = 1;
    // Restrict the step so no pressure goes negative.
    for (let r = 0; r < m; r++) {
      const i = free[r];
      if (dy[r] < 0 && P[i] + alpha * dy[r] < P_FLOOR) {
        const alphaMax = (P[i] - P_FLOOR) / -dy[r];
        if (alphaMax < alpha) alpha = Math.max(alphaMax, 0);
      }
    }

    const Pnew = P.slice();
    let accepted = false;
    let Fnew = F;
    let Jnew = J;
    let activeNew = activePumps;
    let scalesNew = scales;
    let meritNew = merit;
    for (let back = 0; back < 40; back++) {
      for (let r = 0; r < m; r++) {
        const i = free[r];
        Pnew[i] = Math.max(P_FLOOR, P[i] + alpha * dy[r]);
      }
      const assembled = assemble(net, Pnew, opts.extIn, opts.forcePumpGate);
      const sc = computeScales(net, Pnew, opts.extIn, assembled.activePumps);
      const mt = freeMerit(assembled.F, sc, free);
      if (Number.isFinite(mt) && mt < merit) {
        accepted = true;
        Fnew = assembled.F;
        Jnew = assembled.J;
        activeNew = assembled.activePumps;
        scalesNew = sc;
        meritNew = mt;
        break;
      }
      alpha *= 0.5;
      if (alpha < 1e-14) break;
    }

    if (!accepted) {
      // The iterate can be stuck exactly on a kink (a pump start-gate
      // boundary), or on the wrong one of the two smooth branches admitted by
      // the narrow gate band. A plain tiny jitter stays inside that band; on
      // the first restart jump pump-inlet free nodes just below their crossover
      // pressure, then on later attempts use a generic relative jitter.
      let restarted = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const Pj = P.slice();
        if (attempt === 0) {
          for (const pk of net.pumps) {
            const i = pk.nodeIndex;
            if (fixed[i]) continue;
            if (P[i] >= pk.model.startPressureMbar * (1 - 1e-3)) {
              Pj[i] = Math.max(P_FLOOR, pk.model.startPressureMbar * (1 - 2e-3));
            }
          }
        }
        const scale = [1e-3, 1e-2, 5e-2, 2e-1][attempt];
        for (const i of free) {
          if (Pj[i] !== P[i]) continue;
          Pj[i] = Math.max(P_FLOOR, P[i] * (1 - scale));
        }
        const assembledJ = assemble(net, Pj, opts.extIn, opts.forcePumpGate);
        const scJ = computeScales(net, Pj, opts.extIn, assembledJ.activePumps);
        const meritJ = freeMerit(assembledJ.F, scJ, free);
        if (Number.isFinite(meritJ) && meritJ < merit) {
          for (const i of free) P[i] = Pj[i];
          F = assembledJ.F;
          J = assembledJ.J;
          activePumps = assembledJ.activePumps;
          scales = scJ;
          merit = meritJ;
          norm = Math.sqrt(merit / free.length);
          phys = freePhys(F, free);
          restarted = true;
          break;
        }
      }
      if (restarted) continue;
      stopReason = 'line_search_failed';
      break;
    }

    for (let r = 0; r < m; r++) P[free[r]] = Pnew[free[r]];
    F = Fnew;
    J = Jnew;
    activePumps = activeNew;
    scales = scalesNew;
    merit = meritNew;
    iter++;
    norm = Math.sqrt(merit / free.length);
    phys = freePhys(F, free);

    if (isConverged(norm, phys, opts.tolerance)) {
      stopReason = 'tolerance_reached';
      break;
    }
  }

  return result(P, norm, phys, stopReason, iter, opts, activePumps);
}

function result(
  P: number[],
  norm: number,
  phys: number,
  stopReason: ConvergenceReport['stopReason'],
  iter: number,
  opts: NewtonOptions,
  activePumps: boolean[]
): NewtonResult {
  return {
    P,
    convergence: {
      converged: stopReason === 'tolerance_reached',
      stopReason,
      iterations: iter,
      maxIterations: opts.maxIterations,
      tolerance: opts.tolerance,
      finalResidual: norm,
      finalResidualMbarLps: phys
    },
    activePumps
  };
}

/**
 * Per-node throughput scale (mbar L/s): sum of magnitudes of every term in the
 * balance plus a floor. Used to normalise the residual.
 */
function computeScales(
  net: BuiltNetwork,
  P: number[],
  extIn: number[],
  activePumps: boolean[]
): number[] {
  const n = net.nodes.length;
  const scale = new Array<number>(n).fill(SCALE_FLOOR);
  for (const e of net.concEdges) {
    const q = Math.abs(P[e.a] - P[e.b]) *
      (e.cMol + (e.kind === 'pipe' ? e.kVis * ((P[e.a] + P[e.b]) / 2) : 0));
    scale[e.a] += q;
    scale[e.b] += q;
  }
  net.pumps.forEach((pk, k) => {
    if (activePumps[k]) scale[pk.nodeIndex] += Math.abs(pk.model.speedAt(P[pk.nodeIndex]) * P[pk.nodeIndex]);
  });
  for (let i = 0; i < n; i++) scale[i] += Math.abs(extIn[i]);
  // Note: the scale deliberately does NOT include |F_i| itself. Including the
  // residual would make the normalised residual self-referential near the true
  // zero solution (no outgassing), where all throughputs vanish: it would stall
  // at ~1 instead of tending to 0. SCALE_FLOOR only guards against division by
  // zero on completely isolated nodes, which validation rejects anyway.
  return scale;
}

function freeMerit(F: number[], scales: number[], free: number[]): number {
  let s = 0;
  for (const i of free) {
    const r = F[i] / scales[i];
    s += r * r;
  }
  return s;
}

function freeNorm(F: number[], scales: number[], free: number[]): number {
  return Math.sqrt(freeMerit(F, scales, free) / free.length);
}

function freePhys(F: number[], free: number[]): number {
  let m = 0;
  for (const i of free) {
    const a = Math.abs(F[i]);
    if (a > m) m = a;
  }
  return m;
}

/**
 * Normalised residual of a given pressure field (used for reporting after the
 * dynamic integration finishes).
 */
export function residualMetrics(net: BuiltNetwork, P: number[], extIn: number[], fixed?: boolean[]): {
  normalised: number;
  physicalMbarLps: number;
} {
  const { F, activePumps } = assemble(net, P, extIn);
  const scales = computeScales(net, P, extIn, activePumps);
  let s = 0;
  let phys = 0;
  let count = 0;
  for (let i = 0; i < net.nodes.length; i++) {
    if (fixed && fixed[i]) continue;
    const r = F[i] / scales[i];
    s += r * r;
    if (Math.abs(F[i]) > phys) phys = Math.abs(F[i]);
    count++;
  }
  return { normalised: count > 0 ? Math.sqrt(s / count) : 0, physicalMbarLps: phys };
}
