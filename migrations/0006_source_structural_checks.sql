CREATE TABLE source_structural_checks (
 video_id TEXT NOT NULL REFERENCES videos(id), object_key TEXT NOT NULL,
 source_revision TEXT NOT NULL, source_etag TEXT NOT NULL,
 source_bytes INTEGER NOT NULL CHECK(source_bytes>0), parser_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state='verified'),
 result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=4096),
 verified_at INTEGER NOT NULL CHECK(verified_at>0),
 PRIMARY KEY(video_id,object_key,source_revision,source_etag,source_bytes,parser_version)
);
