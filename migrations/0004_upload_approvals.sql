CREATE TABLE upload_approvals (
 id TEXT PRIMARY KEY, scope_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','confirmed','expired')),
 total_bytes INTEGER NOT NULL CHECK(total_bytes>0),
 additional_bytes INTEGER NOT NULL CHECK(additional_bytes>=0 AND additional_bytes<=total_bytes),
 reasons_json TEXT NOT NULL, snapshot_id TEXT, period_start TEXT,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER,
 confirmation_token TEXT
);
CREATE UNIQUE INDEX upload_approvals_active_scope ON upload_approvals(scope_hash)
 WHERE state IN ('prepared','confirmed');
CREATE INDEX upload_approvals_expiry ON upload_approvals(state,expires_at);
CREATE TABLE upload_approval_files (
 id TEXT PRIMARY KEY, approval_id TEXT NOT NULL REFERENCES upload_approvals(id),
 name TEXT NOT NULL, title TEXT NOT NULL, expected_size INTEGER NOT NULL CHECK(expected_size>0 AND expected_size<=21474836480),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 upload_id TEXT REFERENCES uploads(id), claim_token TEXT,
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0 AND reserved_bytes<=expected_size),
 UNIQUE(approval_id,name,expected_size,fingerprint)
);
CREATE INDEX upload_approval_files_identity ON upload_approval_files(name,expected_size,fingerprint);
CREATE UNIQUE INDEX upload_approval_reservation_owner ON reservations(owner_id)
 WHERE kind='upload_approval';
