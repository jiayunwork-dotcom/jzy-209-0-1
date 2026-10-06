/**
 * Public domain types for the vacuum network calculation service.
 *
 * Unit conventions (applied everywhere, regardless of how the input is scaled):
 *   pressure    mbar
 *   volume      L
 *   length      m
 *   diameter    mm
 *   conductance L/s
 *   speed       L/s
 *   throughput  mbar L/s
 *   time        s
 *   temperature K
 *   outgassing  mbar L/s
 */

export type GasSpecies =
  | 'air'
  | 'N2'
  | 'O2'
  | 'H2'
  | 'He'
  | 'Ar'
  | 'Ne'
  | 'CO2'
  | 'water_vapor';

/** Time dependent surface outgassing rate, in mbar L/s. */
export type OutgassingModel =
  | { type: 'constant'; q: number }
  /** q(t) = q100 * (t/100s)^(-alpha), t is clamped to >= 1 s */
  | { type: 'power'; q100: number; alpha: number }
  /** q(t) = qInf + (q0 - qInf) * exp(-t/tau) */
  | { type: 'exponential'; q0: number; qInf: number; tau: number }
  /** q(t) = q0 / (1 + t/tau) */
  | { type: 'rational'; q0: number; tau: number };

export interface ChamberNodeInput {
  id: string;
  kind: 'chamber';
  /** Chamber volume in litres, must be > 0. */
  volumeL: number;
  outgassing?: OutgassingModel;
}

export interface JunctionNodeInput {
  id: string;
  kind: 'junction';
}

export type NodeInput = ChamberNodeInput | JunctionNodeInput;

export interface PipeEdgeInput {
  id: string;
  kind: 'pipe';
  from: string;
  to: string;
  /** Inner diameter in mm, must be > 0. */
  innerDiameterMm: number;
  /** Length in m, must be > 0. */
  lengthM: number;
}

export interface ValveEdgeInput {
  id: string;
  kind: 'valve';
  from: string;
  to: string;
  /**
   * Open conductance in L/s, treated as pressure independent. Must be > 0.
   * Defaults to a very large (essentially ideal) conductance when omitted.
   */
  openConductanceLps?: number;
  /** Default valve position used by pump-down jobs. */
  initiallyOpen?: boolean;
}

export interface PumpEdgeInput {
  id: string;
  kind: 'pump';
  /** Node id of the pump inlet. */
  node: string;
  /**
   * Speed curve S(p), in L/s. Pressure points must be strictly increasing
   * and non-negative; speeds must be non-negative. Linearly interpolated;
   * the value at the nearest end point is used outside the table range.
   * At least one point is required (a constant-speed pump).
   */
  speedTable: Array<{ pressureMbar: number; speedLps: number }>;
  /**
   * Start-up (crossover) pressure in mbar. The pump only operates while its
   * inlet pressure is at or below this value. Must be >= 0.
   */
  startPressureMbar: number;
}

export type EdgeInput = PipeEdgeInput | ValveEdgeInput | PumpEdgeInput;

export interface SystemVersionInput {
  /** Free-form label, e.g. "baseline layout". */
  name?: string;
  description?: string;
  gas: GasSpecies;
  /** Gas temperature in K, must be > 0. */
  temperatureK: number;
  nodes: NodeInput[];
  edges: EdgeInput[];
}

export interface SystemVersion extends SystemVersionInput {
  systemId: string;
  versionId: string;
  version: number;
  createdAt: string;
  /** SHA-256 of the canonicalised system description. */
  fingerprint: string;
}

export interface ValveState {
  /** Valve id -> open (true) / closed (false). Unlisted valves default open. */
  [valveId: string]: boolean;
}

export interface TargetSpec {
  /** Target pressure in mbar for one (or several) chambers. */
  pressureMbar: number;
  /** Chamber ids the target applies to. Defaults to all chambers. */
  chamberIds?: string[];
}

export type JobKind = 'steady' | 'pumpdown';

export interface SteadyJobRequest {
  kind: 'steady';
  versionId: string;
  /** Open/closed state of valves. Omitted valves are treated as open. */
  valveStates?: ValveState;
  /** Solver options. */
  maxIterations?: number;
  tolerance?: number;
  /**
   * Reuse a previous job's solution as the initial iterate. Mapping between
   * versions is performed by node id; nodes that do not exist in the current
   * version are ignored, new nodes fall back to the cold start value.
   */
  hotStartFromJobId?: string;
}

export interface PumpdownJobRequest {
  kind: 'pumpdown';
  versionId: string;
  initialPressureMbar: number;
  target?: TargetSpec;
  /** Abort the integration at this simulation time even if the target is not reached. */
  maxTimeS?: number;
  valveStates?: ValveState;
  /** Maximum number of outer Newton/nonlinear solves (across all time steps). */
  maxIterations?: number;
  /** Convergence tolerance of the algebraic solves. */
  tolerance?: number;
  /** Integrator relative tolerance. */
  relTol?: number;
  /** Integrator absolute tolerance (mbar). */
  absTol?: number;
  /** Cap on the integrator step size in seconds (also aids testing). */
  maxStepS?: number;
  hotStartFromJobId?: string;
}

export type JobRequest = SteadyJobRequest | PumpdownJobRequest;

export type FlowRegime = 'molecular' | 'transition' | 'viscous';

export interface EdgeSteadyReport {
  edgeId: string;
  kind: 'pipe' | 'valve' | 'pump';
  from: string | null;
  to: string | null;
  /** Net throughput from `from` to `to` / into the pump, in mbar L/s. */
  throughputMbarLps: number;
  /** Mean pressure along the element (pumps report inlet pressure). */
  meanPressureMbar: number;
  conductanceLps?: number;
  molecularConductanceLps?: number;
  viscousConductanceLps?: number;
  speedLps?: number;
  regime?: FlowRegime;
  active?: boolean;
}

export interface ConvergenceReport {
  converged: boolean;
  /** Reason iteration stopped. */
  stopReason:
    | 'tolerance_reached'
    | 'max_iterations'
    | 'line_search_failed'
    | 'singular_matrix'
    | 'no_pumps'
    | 'time_limit'
    | 'target_reached'
    | 'failed';
  iterations: number;
  maxIterations: number;
  tolerance: number;
  /** Final residual after the last accepted step (normalised, dimensionless). */
  finalResidual: number;
  /** Final residual in physical units, mbar L/s. */
  finalResidualMbarLps: number;
  /** Total Newton/nonlinear solves performed (pump-down jobs). */
  totalNonlinearSolves?: number;
  /** Number of rejected integrator steps (pump-down jobs). */
  rejectedSteps?: number;
  /** Number of accepted integrator steps (pump-down jobs). */
  acceptedSteps?: number;
  /** Junction Newton solves that did not converge (pump-down jobs). */
  failedStageSolves?: number;
}

export interface SteadyResult {
  kind: 'steady';
  /** Node id -> pressure in mbar. */
  pressuresMbar: Record<string, number>;
  /** Convenience: chamber id -> pressure in mbar. */
  chamberPressuresMbar: Record<string, number>;
  /** Limiting pressure for each chamber. */
  limitingPressureMbar: Record<string, number>;
  edges: EdgeSteadyReport[];
  activePumps: string[];
  convergence: ConvergenceReport;
  /** Outgassing rates used at t -> infinity, mbar L/s per chamber. */
  outgassingMbarLps: Record<string, number>;
}

export interface PumpSwitchEvent {
  timeS: number;
  pumpId: string;
  active: boolean;
  inletPressureMbar: number;
}

export interface TargetHit {
  timeS: number;
  chamberId: string;
  pressureMbar: number;
}

export interface CurvePoint {
  timeS: number;
  pressuresMbar: Record<string, number>;
  activePumps: string[];
}

export interface PumpdownResult {
  kind: 'pumpdown';
  initialPressureMbar: number;
  finalTimeS: number;
  finalPressuresMbar: Record<string, number>;
  /**
   * Chamber id -> time at which the target was reached (s), or null.
   */
  targetTimesS: Record<string, number | null>;
  /** Overall target time (all requested chambers), or null. */
  targetTimeS: number | null;
  allTargetsReached: boolean;
  pumpEvents: PumpSwitchEvent[];
  targetHits: TargetHit[];
  /** Sampled pressure curve (initial point, switch events, target hits, accepted steps). */
  curve: CurvePoint[];
  convergence: ConvergenceReport;
}

export type JobResult = SteadyResult | PumpdownResult;

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  jobId: string;
  systemId: string;
  versionId: string;
  request: JobRequest;
  status: JobStatus;
  progress: number;
  error?: string;
  result?: JobResult;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** True when this record was reused for an identical request. */
  reused?: boolean;
  /** Fingerprint of the version the result was computed against. */
  versionFingerprint: string;
}

export interface ComparisonEntry {
  chamberId: string;
  kind: 'steady' | 'pumpdown';
  metric: 'limitingPressureMbar' | 'targetTimeS';
  oldValue: number | null;
  newValue: number | null;
  /** |new-old|/|old|; null when it cannot be defined. */
  relativeChange: number | null;
  changed: boolean;
}

export interface ComparisonReport {
  systemId: string;
  oldVersionId: string;
  newVersionId: string;
  kind: JobKind;
  ratioThreshold: number;
  entries: ComparisonEntry[];
  changedChambers: string[];
  addedChambers: string[];
  removedChambers: string[];
  oldJobId: string;
  newJobId: string;
}
