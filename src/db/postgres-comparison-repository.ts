import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CalculationKind, CompareResult } from '../types';
import type { ComparisonRepository } from './repository';

export class PostgresComparisonRepository implements ComparisonRepository {
  constructor(private readonly pool: Pool) {}

  async saveComparison(
    input: {
      fromVersionId: string;
      toVersionId: string;
      kind: CalculationKind;
      threshold: number;
      fromJobId: string;
      toJobId: string;
    },
    result?: CompareResult
  ): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO comparisons(id, from_version_id, to_version_id, kind, threshold, from_job_id, to_job_id, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.fromVersionId,
        input.toVersionId,
        input.kind,
        input.threshold,
        input.fromJobId,
        input.toJobId,
        JSON.stringify(result ?? null)
      ]
    );
    return id;
  }
}
