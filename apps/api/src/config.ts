import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

export interface AsrConfig {
  enabled: boolean
  workerToken: string
  resultDir: string
  modelRevision: string
  alignerRevision: string
  pipelineVersion: string
}

export interface TranslationConfig {
  enabled: boolean
  workerToken: string
  resultDir: string
  modelId: string
  modelRevision: string
  modelSha256: string
  promptVersion: string
  pipelineVersion: string
  targetLanguage: string
}

/** The card every GPU consumer leases, named once so the leases collide. */
export interface GpuConfig {
  resourceId: string
}

export interface EmbeddingConfig {
  enabled: boolean
  workerToken: string
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
}

export interface SceneConfig {
  enabled: boolean
  workerToken: string
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  windowMs: number
  overlapMs: number
  /** The CPU text tower that turns a search box into the three query vectors. */
  queryUrl: string
}

export interface FaceConfig {
  enabled: boolean
  workerToken: string
  modelId: string
  modelRevision: string
  modelSha256: string
  pipelineVersion: string
  dimensions: number
  sampleMs: number
  /** Cosine at which a face joins an approved person. */
  matchThreshold: number
  /** Cosine at which two unassigned faces become the same candidate group. */
  candidateThreshold: number
}

export interface ApiConfig {
  port: number
  host: string
  dataDir: string
  cacheDir: string
  mediaRoot: string
  authSecret: string
  accel: boolean
  hwaccel: 'nvenc' | null
  secureCookies: boolean
  /** How stale a library scan may be before the pipeline pass queues another. */
  scanIntervalMs: number
  gpu: GpuConfig
  asr: AsrConfig
  translation: TranslationConfig
  embedding: EmbeddingConfig
  scene: SceneConfig
  face: FaceConfig
}

async function resolveSecret(dataDir: string, fromEnv: string | undefined): Promise<string> {
  const provided = fromEnv?.trim()
  if (provided) return provided

  const file = path.join(dataDir, 'secret.key')
  try {
    const stored = (await readFile(file, 'utf8')).trim()
    if (stored.length >= 32) return stored
  } catch {
    // Generate below.
  }
  const secret = randomBytes(32).toString('hex')
  await writeFile(file, secret, { mode: 0o600 })
  return secret
}

function resolveScanInterval(env: Record<string, string | undefined>): number {
  const minutes = Number(env.SCAN_INTERVAL_MINUTES)
  const value = Number.isFinite(minutes) && minutes >= 1 ? minutes : 15
  return value * 60_000
}

function resolveAsr(env: Record<string, string | undefined>): AsrConfig {
  const token = env.ASR_WORKER_TOKEN?.trim() ?? ''
  const enabled = env.ASR_ENABLED ? env.ASR_ENABLED === '1' : token.length > 0
  if (enabled && token.length < 16) {
    throw new Error('ASR_WORKER_TOKEN must be at least 16 characters when ASR is enabled.')
  }

  return {
    enabled,
    workerToken: token,
    resultDir: path.resolve(env.ASR_RESULT_DIR ?? 'asr-results'),
    modelRevision: env.ASR_MODEL_REVISION?.trim() || 'main',
    alignerRevision: env.ALIGN_MODEL_REVISION?.trim() || 'main',
    pipelineVersion: env.ASR_PIPELINE_VERSION?.trim() || '1',
  }
}

function resolveTranslation(
  env: Record<string, string | undefined>,
  fallbackResultDir: string,
): TranslationConfig {
  const token = env.TRANSLATION_WORKER_TOKEN?.trim() ?? ''
  const enabled = env.TRANSLATION_ENABLED ? env.TRANSLATION_ENABLED === '1' : token.length > 0
  if (enabled && token.length < 16) {
    throw new Error(
      'TRANSLATION_WORKER_TOKEN must be at least 16 characters when translation is enabled.',
    )
  }

  return {
    enabled,
    workerToken: token,
    resultDir: path.resolve(env.TRANSLATION_RESULT_DIR ?? fallbackResultDir),
    modelId: env.TRANSLATION_MODEL_ID?.trim() || 'IndexTeam/Index-Translate-9B-GGUF',
    modelRevision: env.TRANSLATION_MODEL_REVISION?.trim() || 'main',
    modelSha256: env.TRANSLATION_MODEL_SHA256?.trim() || '',
    promptVersion: env.TRANSLATION_PROMPT_VERSION?.trim() || '1',
    pipelineVersion: env.TRANSLATION_PIPELINE_VERSION?.trim() || '1',
    targetLanguage: env.TRANSLATION_TARGET_DEFAULT?.trim() || 'ko',
  }
}

function resolveEmbedding(env: Record<string, string | undefined>): EmbeddingConfig {
  const token = env.EMBEDDING_WORKER_TOKEN?.trim() ?? ''
  const enabled = env.EMBEDDING_ENABLED ? env.EMBEDDING_ENABLED === '1' : token.length > 0
  if (enabled && token.length < 16) {
    throw new Error(
      'EMBEDDING_WORKER_TOKEN must be at least 16 characters when embeddings are enabled.',
    )
  }

  const dimensions = Number(env.EMBEDDING_DIMENSIONS)
  return {
    enabled,
    workerToken: token,
    modelId: env.EMBEDDING_MODEL_ID?.trim() || 'Qwen/Qwen3-Embedding-4B-GGUF',
    modelRevision:
      env.EMBEDDING_MODEL_REVISION?.trim() || 'f4602530db1d980e16da9d7d3a70294cf5c190be',
    modelSha256:
      env.EMBEDDING_MODEL_SHA256?.trim() ||
      '2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b',
    pipelineVersion: env.EMBEDDING_PIPELINE_VERSION?.trim() || '1',
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 2560,
  }
}

function resolveScene(env: Record<string, string | undefined>): SceneConfig {
  const token = env.SCENE_WORKER_TOKEN?.trim() ?? ''
  const enabled = env.SCENE_ENABLED ? env.SCENE_ENABLED === '1' : token.length > 0
  if (enabled && token.length < 16) {
    throw new Error('SCENE_WORKER_TOKEN must be at least 16 characters when scenes are enabled.')
  }

  const dimensions = Number(env.SCENE_DIMENSIONS)
  const windowSeconds = Number(env.SCENE_WINDOW_SECONDS)
  const overlapSeconds = Number(env.SCENE_OVERLAP_SECONDS)
  return {
    enabled,
    workerToken: token,
    modelId: env.SCENE_MODEL_ID?.trim() || 'facebook/pe-av-base-16-frame',
    modelRevision: env.SCENE_MODEL_REVISION?.trim() || 'main',
    modelSha256: env.SCENE_MODEL_SHA256?.trim() || '',
    pipelineVersion: env.SCENE_PIPELINE_VERSION?.trim() || '1',
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 1024,
    windowMs: (Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 10) * 1000,
    overlapMs: (Number.isFinite(overlapSeconds) && overlapSeconds >= 0 ? overlapSeconds : 2) * 1000,
    queryUrl: (env.SCENE_QUERY_URL?.trim() || 'http://scene-query:8091').replace(/\/$/, ''),
  }
}

function resolveFace(env: Record<string, string | undefined>): FaceConfig {
  const token = env.FACE_WORKER_TOKEN?.trim() ?? ''
  const enabled = env.FACE_ENABLED ? env.FACE_ENABLED === '1' : token.length > 0
  if (enabled && token.length < 16) {
    throw new Error('FACE_WORKER_TOKEN must be at least 16 characters when faces are enabled.')
  }

  const dimensions = Number(env.FACE_DIMENSIONS)
  const sampleMs = Number(env.FACE_SAMPLE_MS)
  const match = Number(env.FACE_MATCH_THRESHOLD)
  const candidate = Number(env.FACE_CANDIDATE_THRESHOLD)
  return {
    enabled,
    workerToken: token,
    modelId: env.FACE_MODEL_ID?.trim() || 'antelopev2',
    modelRevision: env.FACE_MODEL_REVISION?.trim() || 'v0.7',
    modelSha256: env.FACE_MODEL_SHA256?.trim() || '',
    pipelineVersion: env.FACE_PIPELINE_VERSION?.trim() || '1',
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 512,
    sampleMs: Number.isFinite(sampleMs) && sampleMs > 0 ? sampleMs : 2000,
    matchThreshold: Number.isFinite(match) ? match : 0.45,
    candidateThreshold: Number.isFinite(candidate) ? candidate : 0.5,
  }
}

export async function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<ApiConfig> {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data')
  const cacheDir = path.resolve(env.CACHE_DIR ?? 'cache')
  const mediaRoot = path.resolve(env.MEDIA_ROOT ?? 'sample-media')
  await mkdir(dataDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

  const asr = resolveAsr(env)
  if (asr.enabled) await mkdir(asr.resultDir, { recursive: true })

  const translation = resolveTranslation(env, env.ASR_RESULT_DIR ?? 'asr-results')
  if (translation.enabled) await mkdir(translation.resultDir, { recursive: true })

  const embedding = resolveEmbedding(env)

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    cacheDir,
    mediaRoot,
    authSecret: await resolveSecret(dataDir, env.AUTH_SECRET),
    accel: env.MEDIA_ACCEL === 'nginx',
    hwaccel: env.HWACCEL === 'nvenc' ? 'nvenc' : null,
    secureCookies: env.COOKIE_SECURE === '1',
    scanIntervalMs: resolveScanInterval(env),
    gpu: { resourceId: env.GPU_RESOURCE?.trim() || 'gpu:0' },
    asr,
    translation,
    embedding,
    scene: resolveScene(env),
    face: resolveFace(env),
  }
}
