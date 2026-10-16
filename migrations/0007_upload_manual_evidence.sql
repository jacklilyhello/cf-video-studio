CREATE TABLE upload_approval_evidence (
 approval_id TEXT PRIMARY KEY REFERENCES upload_approvals(id),
 period_start TEXT NOT NULL,
 period_end TEXT NOT NULL,
 records_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
