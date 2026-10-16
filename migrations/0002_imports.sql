CREATE TABLE import_plans (
 id TEXT PRIMARY KEY, objects_json TEXT NOT NULL, state TEXT NOT NULL,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, result_json TEXT
);
CREATE UNIQUE INDEX videos_source ON videos(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX snapshots_time ON usage_snapshots(fetched_at);
