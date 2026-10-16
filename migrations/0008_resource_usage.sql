-- Resource accounting is separate from expiring admission snapshots and detailed logs.
CREATE TABLE resource_usage_state (
 scope TEXT PRIMARY KEY, checked_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, anchor TEXT, anchor_checked_at INTEGER,
 backfill_day INTEGER, diagnostics_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE resource_usage_latest (
 scope TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
 range_start INTEGER NOT NULL, range_end INTEGER NOT NULL,
 result_json TEXT NOT NULL, observed_at INTEGER NOT NULL,
 diagnostics_json TEXT NOT NULL, checked_at INTEGER NOT NULL,
 PRIMARY KEY(scope,source,kind)
);
CREATE TABLE resource_usage_daily (
 scope TEXT NOT NULL, source TEXT NOT NULL, day_start INTEGER NOT NULL,
 covered_end INTEGER NOT NULL, result_json TEXT NOT NULL, observed_at INTEGER NOT NULL,
 PRIMARY KEY(scope,source,day_start)
);
CREATE TABLE resource_usage_jobs (
 scope TEXT NOT NULL, job_id TEXT NOT NULL, started_at INTEGER NOT NULL,
 ended_at INTEGER NOT NULL, consumption_json TEXT NOT NULL, observed_at INTEGER NOT NULL,
 PRIMARY KEY(scope,job_id)
);
CREATE INDEX resource_usage_jobs_time ON resource_usage_jobs(scope,ended_at,started_at);
CREATE TABLE resource_usage_builds (
 scope TEXT NOT NULL, build_id TEXT NOT NULL, started_at INTEGER NOT NULL,
 ended_at INTEGER, outcome TEXT NOT NULL, observed_at INTEGER NOT NULL,
 PRIMARY KEY(scope,build_id)
);
CREATE INDEX resource_usage_builds_time ON resource_usage_builds(scope,started_at);
