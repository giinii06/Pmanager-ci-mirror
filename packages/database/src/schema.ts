export const SCHEMA_VERSION = 11

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

export const FACE_SQL = `
CREATE TABLE IF NOT EXISTS face_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','detecting','writing','completed','failed','canceled')),
  stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','sampling','detecting','writing','completed')),
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
  sample_ms INTEGER NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_face_jobs_active
  ON face_jobs(asset_id, file_version)
  WHERE state IN ('queued','detecting','writing');
CREATE INDEX IF NOT EXISTS idx_face_jobs_claim ON face_jobs(state, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_face_jobs_lease ON face_jobs(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate','approved','excluded')),
  cover_detection_id TEXT,
  face_count INTEGER NOT NULL DEFAULT 0,
  centroid BLOB,
  dimensions INTEGER,
  model_sha256 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_state ON people(state, face_count DESC);

CREATE TABLE IF NOT EXISTS face_detections (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES face_jobs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  frame_ms INTEGER NOT NULL CHECK (frame_ms >= 0),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  score REAL NOT NULL,
  thumbnail_path TEXT,
  model_sha256 TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_face_detections_asset
  ON face_detections(asset_id, file_version, frame_ms);

CREATE TABLE IF NOT EXISTS face_embeddings (
  detection_id TEXT PRIMARY KEY REFERENCES face_detections(id) ON DELETE CASCADE,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS person_faces (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  detection_id TEXT NOT NULL REFERENCES face_detections(id) ON DELETE CASCADE,
  similarity REAL,
  source TEXT NOT NULL CHECK (source IN ('seed','assigned','manual')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, detection_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_person_faces_detection ON person_faces(detection_id);

CREATE TABLE IF NOT EXISTS person_assets (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  face_count INTEGER NOT NULL,
  best_detection_id TEXT,
  PRIMARY KEY (person_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_person_assets_asset ON person_assets(asset_id);

CREATE TABLE IF NOT EXISTS person_review_actions (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('approve','exclude','merge','split','rename','rescan')),
  payload TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
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
  (exec) => exec(FACE_SQL),
  // A released lease keeps its row so the next acquire can see which kind just
  // let go of the card and step back for one turn.
  (exec) => exec('ALTER TABLE gpu_leases ADD COLUMN released_at INTEGER'),
  // Having no dialogue is a property of the file, so a run that found none
  // still writes a transcript row and the queue stops retrying that file.
  (exec) => exec('ALTER TABLE transcripts ADD COLUMN has_speech INTEGER NOT NULL DEFAULT 1'),
]
