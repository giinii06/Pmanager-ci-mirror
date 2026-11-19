export const SCHEMA_VERSION = 23

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

export const V14_RESILIENCE_AND_VOTES_SQL = `
ALTER TABLE jobs ADD COLUMN worker_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE jobs ADD COLUMN progress_current INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN progress_total INTEGER;
ALTER TABLE jobs ADD COLUMN phase TEXT;
ALTER TABLE jobs ADD COLUMN checkpoint TEXT;
ALTER TABLE jobs ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN completed_at INTEGER;

DROP INDEX IF EXISTS ux_jobs_active;
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_active
  ON jobs(dedupe_key) WHERE state IN ('queued','running','paused');
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(state, lease_expires_at);

ALTER TABLE folders ADD COLUMN cover_width INTEGER;
ALTER TABLE folders ADD COLUMN cover_height INTEGER;
ALTER TABLE folders ADD COLUMN cover_poster_version INTEGER NOT NULL DEFAULT 1;

UPDATE folders
SET cover_width = (SELECT width FROM assets WHERE id = folders.cover_asset_id),
    cover_height = (SELECT height FROM assets WHERE id = folders.cover_asset_id),
    cover_poster_version = COALESCE(
      (SELECT poster_version FROM assets WHERE id = folders.cover_asset_id),
      1
    )
WHERE cover_asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('discover','probe','index','verify','reconcile','finalize','completed','blocked','paused','cancelled','failed')),
  status TEXT NOT NULL CHECK (status IN ('running','paused','cancelled','completed','blocked','failed')),
  resumed_from_run_id TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_added INTEGER NOT NULL DEFAULT 0,
  files_updated INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  files_removed INTEGER NOT NULL DEFAULT 0,
  read_errors INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_lib ON scan_runs(library_id, started_at DESC);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  library_id TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_dir_rel TEXT NOT NULL DEFAULT '',
  last_rel_path TEXT NOT NULL DEFAULT '',
  processed_files INTEGER NOT NULL DEFAULT 0,
  total_estimate INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vote_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('asset','folder')),
  target_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  day_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vote_events_day ON vote_events(day_key, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_events_target ON vote_events(target_type, target_id);

CREATE TABLE IF NOT EXISTS recovery_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  recovered_jobs INTEGER NOT NULL DEFAULT 0,
  cleaned_temp_files INTEGER NOT NULL DEFAULT 0,
  requeued_thumbnails INTEGER NOT NULL DEFAULT 0,
  db_integrity TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_logs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  integrity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  error TEXT
);
`

export const V16_LIBRARY_HEALTH_SQL = `
CREATE TABLE IF NOT EXISTS library_health (
  library_id TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('ONLINE','DEGRADED','OFFLINE','UNVERIFIED')),
  root_identity TEXT,
  last_success_at INTEGER,
  last_error_code TEXT,
  checked_at INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_library_health_state ON library_health(state, checked_at DESC);

ALTER TABLE scan_runs ADD COLUMN mount_identity TEXT;
ALTER TABLE scan_runs ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN missing_ratio REAL NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN authoritative_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN health_state TEXT;
`

// A delete or move is a durable job with its own lease and audit trail. The
// asset keeps a pointer to its mutation so scanner writes cannot resurrect it
// while the file sits in quarantine, and the audit rows deliberately carry no
// foreign key to assets so they survive the final hard delete.
export const V17_FILE_MUTATIONS_SQL = `
CREATE TABLE IF NOT EXISTS file_mutations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('delete','move','copy','extract')),
  asset_id TEXT,
  library_id TEXT,
  user_id TEXT,
  request_key TEXT NOT NULL UNIQUE,
  requested_file_version INTEGER,
  original_deleted_at INTEGER,
  state TEXT NOT NULL CHECK (state IN (
    'requested','validated','quarantined','db_committed','purging','completed',
    'failed_retryable','blocked','cancelled_pre_commit'
  )),
  resume_state TEXT,
  source_rel TEXT,
  quarantine_rel TEXT,
  quarantine_root TEXT,
  manifest_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retry_after INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_file_mutations_state ON file_mutations(state, retry_after, updated_at);
CREATE INDEX IF NOT EXISTS idx_file_mutations_asset ON file_mutations(asset_id, state);

CREATE TABLE IF NOT EXISTS mutation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_redacted TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutation_events_mutation ON mutation_events(mutation_id, created_at);

ALTER TABLE assets ADD COLUMN pending_delete_mutation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_assets_pending_delete ON assets(pending_delete_mutation_id)
  WHERE pending_delete_mutation_id IS NOT NULL;
`

// An HLS generation is immutable once published. The row carries the physical
// attempt directory because two workers can encode the same generation, and
// only the attempt whose fenced publication wins may be served.
export const V18_HLS_GENERATIONS_SQL = `
CREATE TABLE IF NOT EXISTS hls_generations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  profile_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued','running','ready','failed','cancelled','retry_wait','deleting','removed'
  )),
  stage TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  storage_rel TEXT,
  playlist_rel TEXT,
  job_id INTEGER,
  worker_id TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  request_seq INTEGER NOT NULL,
  encoder TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  superseded_at INTEGER,
  eligible_for_gc_at INTEGER,
  last_access_at INTEGER,
  error_code TEXT,
  error_message TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hls_generations_pending
  ON hls_generations(asset_id, file_version, profile_hash)
  WHERE state IN ('queued','running','retry_wait');
CREATE INDEX IF NOT EXISTS idx_hls_generations_lookup
  ON hls_generations(asset_id, file_version, profile_hash, state);
CREATE INDEX IF NOT EXISTS idx_hls_generations_job ON hls_generations(job_id);
CREATE INDEX IF NOT EXISTS idx_hls_generations_gc
  ON hls_generations(state, eligible_for_gc_at);

CREATE TABLE IF NOT EXISTS hls_active (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  profile_hash TEXT NOT NULL,
  generation_id TEXT NOT NULL REFERENCES hls_generations(id) ON DELETE CASCADE,
  request_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, file_version, profile_hash)
);
CREATE INDEX IF NOT EXISTS idx_hls_active_generation ON hls_active(generation_id);

-- A new file version starts a new playback generation. Leaving the old active
-- rows behind would protect their directories from GC forever.
CREATE TRIGGER IF NOT EXISTS trg_assets_version_clears_hls_active
AFTER UPDATE OF file_version ON assets
WHEN NEW.file_version <> OLD.file_version
BEGIN
  DELETE FROM hls_active WHERE asset_id = NEW.id AND file_version <> NEW.file_version;
END;
`

// A session is an opaque random token. Only a keyed digest is stored, so a
// database copy cannot be replayed as a cookie. Expiry is absolute; `last_seen`
// is display metadata and never extends it.
export const V19_AUTH_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

-- One row per admitted login attempt, written before the password hash runs so
-- concurrent requests cannot exceed the limit by all passing the same check.
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','success','failure')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_ip
  ON auth_login_attempts(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_user
  ON auth_login_attempts(username, created_at);

CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  ip TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);
`

// A play session is one playback attempt. Events carry a client-generated id so
// a lost response can be retried without counting the same watch time twice.
// `last_seq` is a high-water mark that only advances on the next contiguous
// sequence, so an overtaken event is refused instead of silently dropped.
export const V20_PLAY_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS play_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  client_session_key TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  view_recorded_at INTEGER,
  last_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, client_session_key)
);
CREATE INDEX IF NOT EXISTS idx_play_sessions_user
  ON play_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_sessions_started ON play_sessions(started_at);

CREATE TABLE IF NOT EXISTS play_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('watch_time','progress','view')),
  delta_ms INTEGER,
  position_ms INTEGER,
  duration_ms INTEGER,
  client_timestamp INTEGER,
  recorded_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

ALTER TABLE playback_progress ADD COLUMN file_version INTEGER;
ALTER TABLE playback_progress ADD COLUMN progress_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playback_progress ADD COLUMN last_session_id TEXT;
ALTER TABLE playback_progress ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;

-- Rows written before this migration have no recorded version. The last saved
-- position was for the asset as it stood then, so the current version is the
-- closest available answer; leaving it NULL would disable resume for everyone.
UPDATE playback_progress
SET file_version = (SELECT file_version FROM assets WHERE assets.id = playback_progress.asset_id);
`

// One row per (job, stage) says how many durable units exist and which manifest
// describes them. The artifact itself lives on the worker's cache volume, so a
// restart can compare the two instead of trusting either one alone.
export const V21_STAGE_CHECKPOINTS_SQL = `
CREATE TABLE IF NOT EXISTS stage_checkpoints (
  job_id TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  file_version INTEGER NOT NULL,
  model_fingerprint TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  completed_units INTEGER NOT NULL,
  total_units INTEGER NOT NULL,
  artifact_manifest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, stage_name)
);
CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_asset
  ON stage_checkpoints(asset_id, file_version);

ALTER TABLE scene_jobs ADD COLUMN analyzed_windows INTEGER;
ALTER TABLE scene_jobs ADD COLUMN total_windows INTEGER;
`

// A fingerprint is a reading of one file version, so it dies with the asset and
// is replaced when the version changes. The quick hash narrows candidates and
// the full hash decides a group; a group is review material only, and nothing
// in this schema can express a deletion. `device_id`/`inode` and `same_inode`
// separate two hardlinks, which share one body of bytes on disk, from two real
// copies, because deleting either half of a hardlink pair destroys both.
export const V22_DUPLICATES_SQL = `
CREATE TABLE IF NOT EXISTS file_fingerprints (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  quick_hash TEXT,
  full_hash TEXT,
  algo TEXT NOT NULL DEFAULT 'sha256',
  device_id INTEGER,
  inode INTEGER,
  calculated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, file_version)
);
CREATE INDEX IF NOT EXISTS idx_file_fingerprints_full ON file_fingerprints(size_bytes, full_hash);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('exact','similar')),
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','ignored','kept')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_duplicate_groups_fingerprint ON duplicate_groups(kind, fingerprint);

CREATE TABLE IF NOT EXISTS duplicate_group_members (
  group_id TEXT NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  confidence REAL NOT NULL,
  same_inode INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_duplicate_group_members_asset ON duplicate_group_members(asset_id);
`

// A smart album is a saved filter, never a copy of a file: the tree is data the
// server compiles, so a corrupt or outdated filter can only fail to parse, and
// nothing here can express a broad match. Playlists, playlist items and
// timestamp bookmarks are ordinary per-user lists and arrive in the same
// migration because they share the collections surface.
export const V23_COLLECTIONS_SQL = `
CREATE TABLE IF NOT EXISTS smart_albums (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  filter_version INTEGER NOT NULL DEFAULT 1,
  filter_json TEXT NOT NULL,
  sort TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_smart_albums_user_name ON smart_albums(user_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_smart_albums_user ON smart_albums(user_id, pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('custom','watch_later')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_playlists_user_name ON playlists(user_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS ux_playlists_watch_later ON playlists(user_id) WHERE kind = 'watch_later';

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id, position, added_at);

CREATE TABLE IF NOT EXISTS video_bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
  title TEXT,
  note TEXT,
  file_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_bookmarks_user_asset ON video_bookmarks(user_id, asset_id, position_ms);
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
  (exec) => exec(V14_RESILIENCE_AND_VOTES_SQL),
  (exec) => exec('ALTER TABLE folders ADD COLUMN pinned_cover_asset_id TEXT'),
  (exec) => {
    exec(V16_LIBRARY_HEALTH_SQL)
    const now = Date.now()
    exec(`INSERT INTO library_health (
             library_id, state, last_success_at, checked_at, consecutive_failures
           )
           SELECT l.id, 'ONLINE', s.completed_at, ${now}, 0
           FROM libraries l
           JOIN scan_runs s ON s.id = (
             SELECT id FROM scan_runs
             WHERE library_id = l.id AND status = 'completed' AND completed_at IS NOT NULL
             ORDER BY completed_at DESC LIMIT 1
           )
           WHERE NOT EXISTS (
             SELECT 1 FROM library_health h WHERE h.library_id = l.id
           )`)
  },
  (exec) => exec(V17_FILE_MUTATIONS_SQL),
  (exec) => exec(V18_HLS_GENERATIONS_SQL),
  (exec) => exec(V19_AUTH_SESSIONS_SQL),
  (exec) => exec(V20_PLAY_SESSIONS_SQL),
  (exec) => exec(V21_STAGE_CHECKPOINTS_SQL),
  (exec) => exec(V22_DUPLICATES_SQL),
  (exec) => exec(V23_COLLECTIONS_SQL),
]
