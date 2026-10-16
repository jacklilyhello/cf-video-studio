CREATE TABLE deletion_items (
 plan_id TEXT NOT NULL REFERENCES deletion_plans(id), key TEXT NOT NULL,
 bytes INTEGER NOT NULL, etag TEXT NOT NULL, video_id TEXT NOT NULL,
 version_id TEXT, category TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 error TEXT, released_bytes INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(plan_id,key)
);
