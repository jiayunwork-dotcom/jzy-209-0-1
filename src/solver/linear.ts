import { SolverError } from '../errors';

/**
 * Dense Gaussian elimination with partial pivoting.
 * Solves A x = b. The matrices are small to moderately sized vacuum networks,
 * where direct dense factorization is simpler and usually faster than a sparse
 * matrix package.
 */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  if (a.length !== n || a.some((row) => row.length !== n)) {
    throw new SolverError('linear system has inconsistent dimensions');
  }
  const m = a.map((row, i) => [...row, b[i]!]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let pivotAbs = Math.abs(m[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(m[row]![col]!);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = row;
      }
    }
    if (pivotAbs < 1e-300) {
      throw new SolverError('singular Jacobian in Newton solver');
    }
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }
    const pivotRow = m[col]!;
    const pivotValue = pivotRow[col]!;
    for (let row = col + 1; row < n; row++) {
      const targetRow = m[row]!;
      const factor = targetRow[col]! / pivotValue;
      if (factor === 0) continue;
      targetRow[col] = 0;
      for (let k = col + 1; k <= n; k++) {
        targetRow[k] = targetRow[k]! - factor * pivotRow[k]!;
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row]![n]!;
    for (let col = row + 1; col < n; col++) {
      sum -= m[row]![col]! * x[col]!;
    }
    x[row] = sum / m[row]![row]!;
  }
  return x;
}

export function normInf(values: number[]): number {
  return values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
}
