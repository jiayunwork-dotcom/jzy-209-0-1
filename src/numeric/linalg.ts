/**
 * Dense linear algebra for the (small, chamber + junction count) network
 * Jacobian. Implemented from scratch as required by the specification.
 */

export class SingularMatrixError extends Error {
  constructor(message = 'singular matrix in LU solve') {
    super(message);
    this.name = 'SingularMatrixError';
  }
}

/**
 * Gaussian elimination with partial pivoting.
 * A is n x n (row-major), b is length n. Solved in place; x is returned.
 */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  if (n === 0) return [];
  // Work on copies to avoid mutating caller data.
  const M = A.map((row) => row.slice());
  const x = b.slice();

  for (let k = 0; k < n; k++) {
    // Partial pivoting.
    let pivot = k;
    let pivotAbs = Math.abs(M[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(M[i][k]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = i;
      }
    }
    if (pivotAbs < 1e-18) {
      throw new SingularMatrixError(`pivot ${k} near zero (${pivotAbs.toExponential(2)})`);
    }
    if (pivot !== k) {
      const tmpRow = M[k];
      M[k] = M[pivot];
      M[pivot] = tmpRow;
      const tmp = x[k];
      x[k] = x[pivot];
      x[pivot] = tmp;
    }
    // Eliminate.
    const pivotVal = M[k][k];
    for (let i = k + 1; i < n; i++) {
      const factor = M[i][k] / pivotVal;
      if (factor === 0) continue;
      M[i][k] = 0;
      for (let j = k + 1; j < n; j++) {
        M[i][j] -= factor * M[k][j];
      }
      x[i] -= factor * x[k];
    }
  }

  // Back substitution.
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/** Euclidean norm. */
export function norm2(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function maxAbs(v: number[]): number {
  let m = 0;
  for (const x of v) {
    const a = Math.abs(x);
    if (a > m) m = a;
  }
  return m;
}
