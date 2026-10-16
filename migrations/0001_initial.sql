PRAGMA foreign_keys = ON;
CREATE TABLE videos (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, source_key TEXT UNIQUE, source_size INTEGER NOT NULL DEFAULT 0,
 source_etag TEXT, source_revision TEXT NOT NULL, source_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading', published INTEGER NOT NULL DEFAULT 0,
 current_version_id TEXT, probe_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX videos_catalog ON videos(published, updated_at DESC);
CREATE TABLE uploads (
 id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), object_key TEXT UNIQUE NOT NULL,
 multipart_id TEXT, fingerprint TEXT NOT NULL, expected_size INTEGER NOT NULL,
 state TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
);
CREATE INDEX uploads_state ON uploads(state, expires_at);
CREATE TABLE upload_parts (
 upload_id TEXT NOT NULL REFERENCES uploads(id), number INTEGER NOT NULL,
 size INTEGER NOT NULL, etag TEXT NOT NULL, sha256 TEXT NOT NULL,
 PRIMARY KEY(upload_id,number)
);
CREATE TABLE versions (
 id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), task_id TEXT UNIQUE,
 prefix TEXT UNIQUE NOT NULL, state TEXT NOT NULL, mode TEXT NOT NULL, quality TEXT NOT NULL,
 manifest TEXT, bytes INTEGER NOT NULL DEFAULT 0, duration REAL, timeline_id TEXT NOT NULL,
 validation_json TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE objects (
 key TEXT PRIMARY KEY, video_id TEXT REFERENCES videos(id), version_id TEXT REFERENCES versions(id),
 category TEXT NOT NULL, bytes INTEGER NOT NULL, etag TEXT, sha256 TEXT, state TEXT NOT NULL DEFAULT 'present',
 updated_at INTEGER NOT NULL
);
CREATE INDEX objects_version ON objects(version_id, state);
CREATE TABLE usage_snapshots (
 id TEXT PRIMARY KEY, period_start TEXT, period_end TEXT, fetched_at INTEGER NOT NULL,
 coverage_end TEXT, complete INTEGER NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE reservations (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, snapshot_id TEXT,
 period_start TEXT, amounts_json TEXT NOT NULL, state TEXT NOT NULL,
 created_at INTEGER NOT NULL, released_at INTEGER
);
CREATE TABLE quotes (
 id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), source_revision TEXT NOT NULL,
 source_etag TEXT NOT NULL, mode TEXT NOT NULL, quality TEXT NOT NULL,
 snapshot_id TEXT, period_start TEXT NOT NULL, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'open', data_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), version_id TEXT NOT NULL REFERENCES versions(id),
 quote_id TEXT UNIQUE NOT NULL REFERENCES quotes(id), state TEXT NOT NULL, stage TEXT NOT NULL,
 progress_json TEXT, error TEXT, started_at INTEGER, deadline_at INTEGER, finished_at INTEGER,
 stop_verified INTEGER NOT NULL DEFAULT 0, stop_evidence_json TEXT, consumption_json TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_state ON jobs(state, created_at);
CREATE TABLE deletion_plans (
 id TEXT PRIMARY KEY, video_id TEXT, kind TEXT NOT NULL, scope_json TEXT NOT NULL,
 fingerprint TEXT NOT NULL, state TEXT NOT NULL, released_bytes INTEGER NOT NULL DEFAULT 0,
 failure_json TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE watch_history (
 host TEXT NOT NULL, visitor_hash TEXT NOT NULL, video_id TEXT NOT NULL REFERENCES videos(id),
 timeline_id TEXT NOT NULL, position REAL NOT NULL, duration REAL NOT NULL, watched INTEGER NOT NULL,
 played_seconds REAL NOT NULL DEFAULT 0, last_event_at INTEGER NOT NULL, event_id TEXT NOT NULL,
 updated_at INTEGER NOT NULL, PRIMARY KEY(host,visitor_hash,video_id)
);
CREATE INDEX history_expiry ON watch_history(updated_at);
CREATE TABLE logs (
 id TEXT PRIMARY KEY, request_id TEXT, video_id TEXT, task_id TEXT, level TEXT NOT NULL,
 stage TEXT NOT NULL, message TEXT NOT NULL, details_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX logs_recent ON logs(created_at DESC);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO settings VALUES ('processing_concurrency','1',0),('task_timeout_seconds','1800',0),
 ('history_retention_days','180',0),('log_retention_days','30',0),('progress_interval_seconds','20',0),
 ('storage_limit_bytes','10737418240',0),('monthly_spend_limit_usd','0',0);
