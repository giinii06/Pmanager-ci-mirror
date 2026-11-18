export const SCHEMA_VERSION = 13

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

export const TRANSLATION_SQL = `
CREATE TABLE IF NOT EXISTS translation_jobs (
  id TEXT PRIMARY KEY,
  source_transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','translating','writing','completed','failed','canceled')),
  stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','starting','translating','writing','completed')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  run_after INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_translation_jobs_active
  ON translation_jobs(source_transcript_id, target_language)
  WHERE state IN ('queued','translating','writing');
CREATE INDEX IF NOT EXISTS idx_translation_jobs_claim
  ON translation_jobs(state, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_translation_jobs_lease
  ON translation_jobs(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES translation_jobs(id) ON DELETE CASCADE,
  source_transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  plain_text TEXT NOT NULL,
  result_dir TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_transcript_id, target_language, model_sha256, prompt_version, pipeline_version)
);
CREATE INDEX IF NOT EXISTS idx_translations_asset
  ON translations(asset_id, file_version, target_language, created_at DESC);

CREATE TABLE IF NOT EXISTS translation_segments (
  translation_id TEXT NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  source_seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text TEXT NOT NULL,
  PRIMARY KEY (translation_id, source_seq)
);

CREATE TABLE IF NOT EXISTS gpu_leases (
  resource_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const REVIEW_SQL = `
CREATE TABLE IF NOT EXISTS asset_reviews (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(asset_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_reviews_asset
  ON asset_reviews(asset_id, updated_at DESC);
`

export const EMBEDDING_SQL = `
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  source_transcript_id TEXT REFERENCES transcripts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued','embedding','writing','completed','failed','canceled')),
  stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','starting','embedding','writing','completed')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  run_after INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_embedding_jobs_active
  ON embedding_jobs(asset_id, file_version)
  WHERE state IN ('queued','embedding','writing');
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_claim ON embedding_jobs(state, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_lease ON embedding_jobs(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS video_embeddings (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES embedding_jobs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  source_transcript_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('title','chunk')),
  chunk_index INTEGER NOT NULL DEFAULT 0,
  start_ms INTEGER,
  end_ms INTEGER,
  text TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_embeddings_asset
  ON video_embeddings(asset_id, file_version, kind, chunk_index);
`

export const SCENE_SQL = `
CREATE TABLE IF NOT EXISTS scene_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','extracting','embedding','writing','completed','failed','canceled')),
  stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','extracting','embedding','writing','completed')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  run_after INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  overlap_ms INTEGER NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_jobs_active
  ON scene_jobs(asset_id, file_version)
  WHERE state IN ('queued','extracting','embedding','writing');
CREATE INDEX IF NOT EXISTS idx_scene_jobs_claim ON scene_jobs(state, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_scene_jobs_lease ON scene_jobs(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS video_scenes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scene_jobs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  thumbnail_path TEXT,
  model_sha256 TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(asset_id, file_version, model_sha256, pipeline_version, seq)
);
CREATE INDEX IF NOT EXISTS idx_video_scenes_asset
  ON video_scenes(asset_id, file_version, seq);

CREATE TABLE IF NOT EXISTS scene_embeddings (
  scene_id TEXT NOT NULL REFERENCES video_scenes(id) ON DELETE CASCADE,
  modality TEXT NOT NULL CHECK (modality IN ('visual','audio','av')),
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (scene_id, modality)
);
`

export const OVERHAUL_V13_SQL = `
DROP TABLE IF EXISTS person_review_actions;
DROP TABLE IF EXISTS person_assets;
DROP TABLE IF EXISTS person_faces;
DROP TABLE IF EXISTS face_embeddings;
DROP TABLE IF EXISTS face_detections;
DROP TABLE IF EXISTS face_jobs;
DROP TABLE IF EXISTS people;

ALTER TABLE assets ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN watch_time_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN vote_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN poster_version INTEGER NOT NULL DEFAULT 1;

UPDATE assets
SET vote_count = vote_count + (
  SELECT COUNT(*) FROM favorites f WHERE f.asset_id = assets.id
)
WHERE EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id = assets.id);

DROP TABLE IF EXISTS favorites;

ALTER TABLE folders ADD COLUMN vote_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

UPDATE folders
SET created_at = COALESCE(
  (SELECT MIN(a.indexed_at) FROM assets a WHERE a.folder_id = folders.id AND a.deleted_at IS NULL),
  0
)
WHERE created_at = 0;

CREATE INDEX IF NOT EXISTS idx_assets_kind_views
  ON assets(kind, view_count DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_kind_watch
  ON assets(kind, watch_time_ms DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_kind_votes
  ON assets(kind, vote_count DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_kind_name
  ON assets(kind, filename COLLATE NOCASE ASC, id ASC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_folder_kind
  ON assets(folder_id, kind, view_count) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_video_avg
  ON assets(watch_time_ms, view_count)
  WHERE deleted_at IS NULL AND kind = 'video' AND view_count > 0 AND watch_time_ms > 0;

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id, asset_id);

CREATE TABLE IF NOT EXISTS contribution_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('folder','video')),
  entity_key TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  day_key TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  UNIQUE(entity_type, entity_key)
);
CREATE INDEX IF NOT EXISTS idx_contributions_day ON contribution_events(day_key, occurred_at);

CREATE TABLE IF NOT EXISTS archive_jobs (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  archive_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','extracting','converting','completed','failed_password','failed')),
  password_used TEXT,
  extracted_files INTEGER NOT NULL DEFAULT 0,
  converted_images INTEGER NOT NULL DEFAULT 0,
  converted_videos INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_jobs_sig
  ON archive_jobs(library_id, archive_path, signature);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_state ON archive_jobs(state, updated_at DESC);
`

export const MIGRATIONS: Array<(exec: (sql: string) => void) => void> = [
  (exec) => exec(SCHEMA_SQL),
  (exec) => exec('ALTER TABLE folders ADD COLUMN cover_asset_id TEXT'),
  (exec) => exec(ASR_SQL),
  (exec) => exec(TRANSLATION_SQL),
  (exec) => {
    // The claim stamps these, so a running row can report how long it has run
    // without counting the time it spent waiting in the queue.
    exec('ALTER TABLE jobs ADD COLUMN started_at INTEGER')
    exec('ALTER TABLE asr_jobs ADD COLUMN started_at INTEGER')
    exec('ALTER TABLE translation_jobs ADD COLUMN started_at INTEGER')
  },
  (exec) => exec(REVIEW_SQL),
  (exec) => exec(EMBEDDING_SQL),
  (exec) => exec(SCENE_SQL),
  // Face recognition was removed; existing face tables are dropped in migration 13.
  () => {},
  // A released lease keeps its row so the next acquire can see which kind just
  // let go of the card and step back for one turn.
  (exec) => exec('ALTER TABLE gpu_leases ADD COLUMN released_at INTEGER'),
  // Having no dialogue is a property of the file, so a run that found none
  // still writes a transcript row and the queue stops retrying that file.
  (exec) => exec('ALTER TABLE transcripts ADD COLUMN has_speech INTEGER NOT NULL DEFAULT 1'),
  // One row per reconciler. A pass continues after the last id it looked at, so
  // every eligible video is reached across passes instead of the same head.
  (exec) =>
    exec(`CREATE TABLE IF NOT EXISTS pipeline_cursors (
      name TEXT PRIMARY KEY,
      last_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
  (exec) => exec(OVERHAUL_V13_SQL),
]
