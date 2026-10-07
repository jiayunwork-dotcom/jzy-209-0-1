/**
 * Public domain model and calculation result types.
 *
 * Units used throughout the numerical code:
 * - pressure: mbar
 * - volume: L
 * - conductance / pumping speed: L/s
 * - gas throughput: mbar*L/s
 * - outgassing rate: mbar*L/s (not areal outgassing)
 * - length/diameter: cm
 * - time: s
 * - temperature: K
 */

export type GasSpecies = 'air' | 'N2' | 'O2' | 'Ar' | 'He' | 'H2' | 'CO2';

export type Outgassing =
  | { kind: 'constant'; rate: number }
  | { kind: 'exponential'; rate0: number; tau: number }
  | { kind: 'power'; rate0: number; alpha: number; t0?: number };

export interface ChamberNode {
  id: string;
  kind: 'chamber';
  /** Chamber volume in L; must be positive. */
  volume: number;
  /** Total surface outgassing in mbar*L/s. */
  outgassing?: Outgassing;
}

export interface JunctionNode {
  id: string;
  kind: 'junction';
}

export type SystemNode = ChamberNode | JunctionNode;

export interface PipeEdge {
  id: string;
  kind: 'pipe';
  a: string;
  b: string;
  /** Inner diameter in cm; must be positive. */
  diameter: number;
  /** Axial length in cm; must be positive. */
  length: number;
}

export interface ValveEdge {
  id: string;
  kind: 'valve';
  a: string;
  b: string;
  /**
   * An open valve is modelled as an ideal zero-resistance connection (the
   * joined nodes are merged). A closed valve has zero conductance.
   */
  defaultOpen?: boolean;
}

export interface PumpEdge {
  id: string;
  kind: 'pump';
  /** Node at pump inlet. */
  from: string;
  /** Pumping-speed curve points, pressure in mbar and speed in L/s. */
  curve: Array<{ pressure: number; speed: number }>;
  /**
   * Pumping-start upper pressure limit. The pump stays idle at pressures
   * above this value and latches on once the inlet pressure has fallen to
   * it. Omit to assume the pump can operate at every pressure.
   */
  startPressure?: number;
}

export type SystemEdge = PipeEdge | ValveEdge | PumpEdge;

export interface VacuumSystem {
  name?: string;
  description?: string;
  /** Defaults to air. */
  gas?: GasSpecies;
  /** Global gas temperature in K; defaults to 293.15 K (20 °C). */
  temperature?: number;
  nodes: SystemNode[];
  edges: SystemEdge[];
}

export interface SteadyParams {
  /** Valve overrides. Omitted valves use their defaultOpen value. */
  valveStates?: Record<string, boolean>;
  /**
   * Starting pressure used to determine pump availability. It does not alter
   * the final algebraic solution once the active pump set is determined.
   */
  initialPressure?: number;
  maxIterations?: number;
  residualTolerance?: number;
}

export interface TransientParams {
  valveStates?: Record<string, boolean>;
  /** Common initial pressure in mbar; defaults to initialPressures. */
  initialPressure?: number;
  /** Per-node initial pressures override the common value. */
  initialPressures?: Record<string, number>;
  /** Stop once every listed chamber reaches its target pressure. */
  targets?: Record<string, number>;
  /** Common target pressure for every chamber. */
  targetPressure?: number;
  maxTime?: number;
  maxIterations?: number;
  residualTolerance?: number;
  /** Initial integrator step; adaptive stepping subsequently controls it. */
  initialStep?: number;
  maxStep?: number;
  minStep?: number;
}

export interface NodePressure {
  nodeId: string;
  pressure: number;
}

export interface SteadyResult {
  pressures: NodePressure[];
  pumps: Array<{ pumpId: string; active: boolean; inletPressure: number | null }>;
  mergedGroups: string[][];
  iterations: number;
  maxIterations: number;
  finalResidual: number;
  rawResidual: number;
  residualTolerance: number;
  converged: boolean;
  activePumps: string[];
}

export interface PumpSwitchEvent {
  time: number;
  pumpId: string;
  inletPressure: number;
  reason: 'start-pressure-reached';
}

export interface TargetArrival {
  nodeId: string;
  target: number;
  time: number | null;
  pressure: number;
}

export interface PressurePoint {
  time: number;
  pressures: NodePressure[];
}

export interface TransientResult {
  curve: PressurePoint[];
  targetArrivals: TargetArrival[];
  pumpSwitches: PumpSwitchEvent[];
  activePumpsAtEnd: string[];
  finalTime: number;
  finalPressures: NodePressure[];
  iterations: number;
  acceptedSteps: number;
  rejectedSteps: number;
  finalResidual: number;
  rawResidual: number;
  residualTolerance: number;
  converged: boolean;
  finished: boolean;
  stopReason: 'targets-reached' | 'max-time' | 'cancelled' | 'solver-failure';
  ultimatePressureCheck?: NodePressure[];
}

export type CalculationKind = 'steady' | 'transient';

export interface CalculationRequest {
  kind: CalculationKind;
  params?: SteadyParams | TransientParams;
  /** Reuse a previously calculated result as initial guess (steady only). */
  hotStartFromJobId?: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobProgress {
  status: JobStatus;
  phase?: string;
  time?: number;
  acceptedSteps?: number;
  rejectedSteps?: number;
  iterations?: number;
  finalResidual?: number;
  converged?: boolean;
  message?: string;
}

export interface JobRecord {
  id: string;
  versionId: string;
  kind: CalculationKind;
  params: SteadyParams | TransientParams;
  hotStartFromJobId: string | null;
  paramsHash: string;
  status: JobStatus;
  progress: JobProgress;
  result: SteadyResult | TransientResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SystemVersion {
  id: string;
  parentVersionId: string | null;
  version: number;
  system: VacuumSystem;
  createdAt: string;
}

export interface CompareRequest {
  fromVersionId: string;
  toVersionId: string;
  kind: CalculationKind;
  params?: SteadyParams | TransientParams;
  /** Relative change threshold, e.g. 0.1 means a 10% change. */
  threshold?: number;
  hotStart?: boolean;
}

export interface ChamberChange {
  nodeId: string;
  from: number | null;
  to: number | null;
  relativeChange: number | null;
  exceedsThreshold: boolean;
  metric: 'ultimatePressure' | 'pumpdownTime';
}

export interface CompareResult {
  status: 'ready' | 'pending' | 'failed' | 'cancelled';
  threshold: number;
  fromJobId: string;
  toJobId: string;
  changed: ChamberChange[];
  exceeds: ChamberChange[];
  addedNodes: string[];
  removedNodes: string[];
}
