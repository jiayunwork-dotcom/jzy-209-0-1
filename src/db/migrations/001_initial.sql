-- Application schema for the vacuum calculation service.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_versions (
  id UUID PRIMARY KEY,
  parent_version_id UUID REFERENCES system_versions(id),
  version INTEGER NOT NULL,
  system JSONB NOT NULL,
  system_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_versions_version ON system_versions(version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_versions_version ON system_versions(version);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES system_versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('steady', 'transient')),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  hot_start_from_job_id UUID REFERENCES jobs(id),
  params_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_version ON jobs(version_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Physical identity intentionally excludes hot_start_from_job_id: a hot start
-- changes the initial guess only. A partial unique index also collapses racing
-- duplicate submissions while the first job is queued or running.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_reuse
  ON jobs(version_id, kind, params_hash)
  WHERE status IN ('succeeded', 'queued', 'running');

CREATE TABLE IF NOT EXISTS comparisons (
  id UUID PRIMARY KEY,
  from_version_id UUID NOT NULL REFERENCES system_versions(id),
  to_version_id UUID NOT NULL REFERENCES system_versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('steady', 'transient')),
  threshold DOUBLE PRECISION NOT NULL,
  from_job_id UUID NOT NULL REFERENCES jobs(id),
  to_job_id UUID NOT NULL REFERENCES jobs(id),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comparisons_versions
  ON comparisons(from_version_id, to_version_id);
