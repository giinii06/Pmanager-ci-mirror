export const SCHEMA_VERSION = 3

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

export const ASR_SQL = `
CREATE TABLE IF NOT EXISTS asr_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','transcribing','aligning','writing','completed','failed','canceled')),
  stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','extracting','chunking','transcribing','aligning','writing','completed')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  run_after INTEGER NOT NULL DEFAULT 0,
  model_revision TEXT NOT NULL,
  aligner_revision TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_asr_jobs_active
  ON asr_jobs(asset_id, file_version)
  WHERE state IN ('queued','transcribing','aligning','writing');
CREATE INDEX IF NOT EXISTS idx_asr_jobs_claim ON asr_jobs(state, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_asr_jobs_lease ON asr_jobs(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES asr_jobs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'ko',
  result_dir TEXT NOT NULL,
  plain_text TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  aligner_revision TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(asset_id, file_version, model_revision, aligner_revision, pipeline_version)
);
CREATE INDEX IF NOT EXISTS idx_transcripts_asset ON transcripts(asset_id, file_version, created_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text TEXT NOT NULL,
  PRIMARY KEY (transcript_id, seq)
);
`

export const MIGRATIONS: Array<(exec: (sql: string) => void) => void> = [
  (exec) => exec(SCHEMA_SQL),
  (exec) => exec('ALTER TABLE folders ADD COLUMN cover_asset_id TEXT'),
  (exec) => exec(ASR_SQL),
]
