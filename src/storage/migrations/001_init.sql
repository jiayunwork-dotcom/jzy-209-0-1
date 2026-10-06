-- PostgreSQL 16 schema for the vacuum network service.
-- Idempotent: safe to run on every application start.

CREATE TABLE IF NOT EXISTS systems (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS versions (
  id            TEXT PRIMARY KEY,
  system_id     TEXT NOT NULL REFERENCES systems(id),
  version_no    INTEGER NOT NULL,
  name          TEXT,
  description   TEXT,
  fingerprint   TEXT NOT NULL,
  definition    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (system_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions_system ON versions(system_id, version_no);

CREATE TABLE IF NOT EXISTS jobs (
  id                    TEXT PRIMARY KEY,
  system_id             TEXT NOT NULL,
  version_id            TEXT NOT NULL REFERENCES versions(id),
  version_fingerprint   TEXT NOT NULL,
  dedup_key             TEXT UNIQUE,
  request               JSONB NOT NULL,
  status                TEXT NOT NULL,
  progress              DOUBLE PRECISION NOT NULL DEFAULT 0,
  error                 TEXT,
  result                JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_version ON jobs(version_id, created_at);
