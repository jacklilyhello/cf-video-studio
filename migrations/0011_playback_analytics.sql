CREATE TABLE analytics_sessions (
 id TEXT PRIMARY KEY, visitor TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL,
 video_id TEXT NOT NULL DEFAULT '', version_id TEXT NOT NULL DEFAULT '',
 started_at INTEGER NOT NULL, last_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
 counted INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0,
 ip TEXT, country TEXT NOT NULL DEFAULT '未知', region TEXT, city TEXT, asn INTEGER,
 ua TEXT, browser TEXT NOT NULL, os TEXT NOT NULL, device TEXT NOT NULL, referrer_host TEXT,
 active INTEGER NOT NULL DEFAULT 0,
 started INTEGER NOT NULL DEFAULT 0, watched_seconds REAL NOT NULL DEFAULT 0,
 duration REAL NOT NULL DEFAULT 0, intervals_json TEXT NOT NULL DEFAULT '[]',
 completed INTEGER NOT NULL DEFAULT 0, startup_ms REAL, errors INTEGER NOT NULL DEFAULT 0,
 stalls INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '访问'
);
CREATE INDEX analytics_session_time ON analytics_sessions(started_at);
CREATE INDEX analytics_session_owner ON analytics_sessions(visitor,host,last_at);
CREATE INDEX analytics_session_video ON analytics_sessions(video_id,started_at);
CREATE TABLE analytics_daily (
 day TEXT NOT NULL, host TEXT NOT NULL, video_id TEXT NOT NULL,
 country TEXT NOT NULL, browser TEXT NOT NULL, os TEXT NOT NULL, device TEXT NOT NULL,
 visits INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 watched_seconds REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0, stalls INTEGER NOT NULL DEFAULT 0,
 startup_total_ms REAL NOT NULL DEFAULT 0, startup_count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day,host,video_id,country,browser,os,device)
);
INSERT OR IGNORE INTO settings(key,value,updated_at)
 VALUES('analytics_since',CAST(unixepoch('now')*1000 AS TEXT),unixepoch('now')*1000);

-- Privacy-minimized 30-second reporting deltas support rolling ranges. No IP,
-- user-agent, token, cookie or referrer is copied into this table.
CREATE TABLE analytics_increments (
 session_id TEXT NOT NULL, seq INTEGER NOT NULL,
 visitor TEXT NOT NULL, host TEXT NOT NULL, video_id TEXT NOT NULL,
 country TEXT NOT NULL, browser TEXT NOT NULL, os TEXT NOT NULL, device TEXT NOT NULL,
 start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
 visits INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
 watched_seconds REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0, stalls INTEGER NOT NULL DEFAULT 0,
 startup_total_ms REAL NOT NULL DEFAULT 0, startup_count INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id,seq)
);
CREATE INDEX analytics_increment_time ON analytics_increments(end_at,start_at);
CREATE INDEX analytics_increment_video ON analytics_increments(video_id,end_at);
