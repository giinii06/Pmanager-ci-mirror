export const SCHEMA_VERSION = 2

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_scan_at INTEGER,
  scan_state TEXT NOT NULL DEFAULT 'idle',
  scanned_files INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL,
  asset_count INTEGER NOT NULL DEFAULT 0,
  last_seen_scan TEXT,
  UNIQUE(library_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_folders_library ON folders(library_id, relative_path);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  taken_at INTEGER NOT NULL,
  file_version INTEGER NOT NULL DEFAULT 1,
  video_codec TEXT,
  audio_codec TEXT,
  container TEXT,
  indexed_at INTEGER NOT NULL,
  deleted_at INTEGER,
  last_seen_scan TEXT,
  UNIQUE(library_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_assets_timeline ON assets(taken_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder_id, taken_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_library ON assets(library_id, taken_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind, taken_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_recent ON favorites(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS playback_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, asset_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL,
  asset_id TEXT,
  library_id TEXT,
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  run_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_active ON jobs(dedupe_key) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_jobs_pick ON jobs(state, priority, run_after, id);
`

export const MIGRATIONS: Array<(exec: (sql: string) => void) => void> = [
  (exec) => exec(SCHEMA_SQL),
  (exec) => exec('ALTER TABLE folders ADD COLUMN cover_asset_id TEXT'),
]
