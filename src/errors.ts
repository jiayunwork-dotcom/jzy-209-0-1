export class ValidationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class CancellationError extends Error {
  constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export class SolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolverError';
  }
}
