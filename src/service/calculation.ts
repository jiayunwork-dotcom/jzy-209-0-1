import type {
  CalculationKind,
  SteadyParams,
  SteadyResult,
  SystemVersion,
  TransientParams,
  TransientResult,
  VacuumSystem
} from '../types';
import { prepareNetwork } from '../solver/network';
import { solveSteady } from '../solver/steady';
import { runTransient, type CancelToken, type ProgressCallback } from '../solver/transient';
import {
  assertNoValidationIssues,
  assertValidSystem,
  validateSteadyParams,
  validateTransientParams
} from '../physics/validation';
import { NotFoundError, SolverError } from '../errors';

export interface RunOptions {
  hotStartResult?: SteadyResult;
  cancelToken?: CancelToken;
  onProgress?: ProgressCallback;
}

export function runSteadyCalculation(
  system: VacuumSystem,
  params: SteadyParams | undefined,
  options: RunOptions = {}
): SteadyResult {
  assertValidSystem(system);
  assertNoValidationIssues(validateSteadyParams(system, params));
  const network = prepareNetwork(system, params?.valveStates);
  let initialGuess: number[] | undefined;
  if (options.hotStartResult) {
    initialGuess = mapHotStart(network, options.hotStartResult);
  }
  return solveSteady(network, {
    initialPressure: params?.initialPressure,
    maxIterations: params?.maxIterations,
    residualTolerance: params?.residualTolerance,
    initialGuess
  });
}

export function runTransientCalculation(
  system: VacuumSystem,
  params: TransientParams | undefined,
  options: RunOptions = {}
): TransientResult {
  assertValidSystem(system);
  assertNoValidationIssues(validateTransientParams(system, params));
  return runTransient(system, {
    params,
    cancelToken: options.cancelToken,
    onProgress: options.onProgress
  });
}

/**
 * Map pressures from an old network to a newly prepared one. Nodes are matched
 * by stable node id. A merged group receives the geometric mean of its mapped
 * member pressures; groups with no surviving member fall back to the cold-start
 * pressure inside Newton's solver.
 */
export function mapHotStart(
  network: ReturnType<typeof prepareNetwork>,
  oldResult: SteadyResult
): number[] {
  const oldPressure = new Map(oldResult.pressures.map((x) => [x.nodeId, x.pressure]));
  return network.groups.map((group) => {
    const mapped = group.memberIds
      .map((id) => oldPressure.get(id))
      .filter((value): value is number => typeof value === 'number' && value > 0);
    if (mapped.length === 0) return 1013.25;
    const product = mapped.reduce((acc, v) => acc * v, 1);
    return Math.pow(product, 1 / mapped.length);
  });
}

export function runCalculation(
  version: SystemVersion,
  kind: CalculationKind,
  params: SteadyParams | TransientParams | undefined,
  options: RunOptions = {}
): SteadyResult | TransientResult {
  if (kind === 'steady') {
    return runSteadyCalculation(version.system, params as SteadyParams | undefined, options);
  }
  if (kind === 'transient') {
    if (options.hotStartResult) {
      throw new SolverError('hot start is supported for steady calculations only');
    }
    return runTransientCalculation(version.system, params as TransientParams | undefined, options);
  }
  throw new NotFoundError(`unknown calculation kind ${String(kind)}`);
}
