import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys are sorted recursively so that semantically equal
 * descriptions serialise to identical strings (used for fingerprints and for
 * the duplicate-job lookup key).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sortValue((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fingerprint of a system description payload.
 */
export function fingerprintSystem(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

/**
 * Dedup key for a job. Hot start source and run-control options that do not
 * change the physical answer are excluded, so a hot-started run and a cold run
 * of the same physical case share the cache entry.
 */
export function jobDedupKey(versionId: string, versionFingerprint: string, req: unknown): string {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(req));
  delete clone.hotStartFromJobId;
  delete clone.maxIterations;
  delete clone.tolerance;
  delete clone.relTol;
  delete clone.absTol;
  delete clone.maxStepS;
  delete clone.versionId;
  return `${versionId}:${versionFingerprint}:${canonicalJson(clone)}`;
}

export function generateId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}
