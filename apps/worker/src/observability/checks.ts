import { stat, statfs } from 'node:fs/promises'
import {
  countWorkerInstancesSince,
  getLatestBackupLog,
  listLibraries,
  listLibraryHealth,
  workQueue,
  type Db,
  type NotificationFinding,
} from '@mediavault/database'
import { resolveInside } from '@mediavault/media'
import type { WorkerConfig } from '../config'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long a persisting condition stays quiet before it is announced again. */
export const ALERT_COOLDOWNS = {
  drive_offline: 15 * MINUTE,
  mass_missing: 6 * HOUR,
  disk_low: HOUR,
  gpu_oom: HOUR,
  job_stalled: 15 * MINUTE,
  backup_missing: 6 * HOUR,
  backup_failed: HOUR,
  db_integrity: 15 * MINUTE,
  restart_loop: HOUR,
  mutation_failed: HOUR,
} as const

const GPU_OOM_WINDOW_MS = 30 * MINUTE
const GPU_OOM_THRESHOLD = 3
const BACKUP_STALE_MS = 48 * HOUR
const RESTART_WINDOW_MS = HOUR
const RESTART_THRESHOLD = 5
const INTEGRITY_CACHE_MS = 10 * MINUTE

export interface AlertFinding extends NotificationFinding {
  cooldownMs: number
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

let integrityCache: { checkedAt: number; value: string } | null = null

function databaseIntegrity(db: Db, now: number): string {
  if (integrityCache && now - integrityCache.checkedAt < INTEGRITY_CACHE_MS) {
    return integrityCache.value
  }
  const value =
    db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check ?? 'unknown'
  integrityCache = { checkedAt: now, value }
  return value
}

async function libraryFindings(
  db: Db,
  config: WorkerConfig,
): Promise<AlertFinding[]> {
  const findings: AlertFinding[] = []
  const health = new Map(listLibraryHealth(db).map((row) => [row.libraryId, row]))

  for (const library of listLibraries(db)) {
    const record = health.get(library.id)
    const abs = resolveInside(config.mediaRoot, library.rootPath)
    let accessible = false
    if (abs !== null) {
      try {
        accessible = (await stat(abs)).isDirectory()
      } catch {
        accessible = false
      }
    }

    if (record?.state === 'OFFLINE' || !accessible) {
      findings.push({
        kind: 'drive_offline',
        severity: 'critical',
        dedupeKey: `library:${library.id}:offline`,
        title: `원본 저장소 연결 끊김: ${library.name}`,
        body:
          record?.lastErrorCode
            ? `${library.name} 라이브러리의 원본 경로에 접근할 수 없습니다 (${record.lastErrorCode}). 드라이브 연결을 확인해 주세요.`
            : `${library.name} 라이브러리의 원본 경로에 접근할 수 없습니다. 드라이브 연결을 확인해 주세요.`,
        metadata: {
          libraryId: library.id,
          rootPath: library.rootPath,
          consecutiveFailures: record?.consecutiveFailures ?? null,
        },
        cooldownMs: ALERT_COOLDOWNS.drive_offline,
      })
      continue
    }

    if (record?.state === 'UNVERIFIED' || record?.lastErrorCode === 'delete_guard') {
      findings.push({
        kind: 'mass_missing',
        severity: 'warning',
        dedupeKey: `library:${library.id}:mass_missing`,
        title: `대량 누락 의심: ${library.name}`,
        body: `${library.name} 라이브러리에서 많은 파일이 사라진 것으로 보여 스캔 삭제가 보류되었습니다. 드라이브 마운트와 경로를 확인한 뒤 스캔을 다시 실행해 주세요.`,
        metadata: {
          libraryId: library.id,
          lastError: library.lastError,
          healthState: record?.state ?? null,
        },
        cooldownMs: ALERT_COOLDOWNS.mass_missing,
      })
    }
  }

  return findings
}

async function diskFindings(config: WorkerConfig): Promise<AlertFinding[]> {
  const findings: AlertFinding[] = []
  const volumes: Array<[string, string]> = [
    ['media', config.mediaRoot],
    ['cache', config.cacheDir],
    ['data', config.dataDir],
  ]

  for (const [label, root] of volumes) {
    let totalBytes: number
    let freeBytes: number
    try {
      const info = await statfs(root)
      totalBytes = info.bsize * info.blocks
      freeBytes = info.bsize * info.bavail
    } catch {
      continue
    }
    const ratio = totalBytes > 0 ? freeBytes / totalBytes : 0
    if (freeBytes >= (config.minFreeBytes ?? 2 * 1024 ** 3) && ratio >= (config.minFreeRatio ?? 0.1)) {
      continue
    }
    findings.push({
      kind: 'disk_low',
      severity: 'critical',
      dedupeKey: `disk:${label}`,
      title: `저장 공간 부족: ${label}`,
      body: `${label} 볼륨의 여유 공간이 ${gb(freeBytes)} (${percent(ratio)}) 남았습니다. 캐시를 정리하거나 공간을 확보해 주세요.`,
      metadata: { volume: label, freeBytes, totalBytes, freeRatio: ratio },
      cooldownMs: ALERT_COOLDOWNS.disk_low,
    })
  }

  return findings
}

function gpuFinding(db: Db, now: number): AlertFinding | null {
  const count =
    db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE state = 'failed' AND last_error LIKE '[GPU_OOM]%' AND completed_at >= ?`,
      )
      .get(now - GPU_OOM_WINDOW_MS)?.n ?? 0
  if (count < GPU_OOM_THRESHOLD) return null
  return {
    kind: 'gpu_oom',
    severity: 'warning',
    dedupeKey: 'gpu:oom',
    title: 'GPU 메모리 부족 반복',
    body: `최근 30분 동안 GPU 메모리 부족으로 ${count}건의 작업이 실패했습니다. 동시 실행 설정과 모델 크기를 확인해 주세요.`,
    metadata: { count, windowMinutes: 30 },
    cooldownMs: ALERT_COOLDOWNS.gpu_oom,
  }
}

function stalledFindings(db: Db, config: WorkerConfig, now: number): AlertFinding[] {
  const queue = workQueue(db, now, config.gpuResource, { maxSceneWindows: 120 })
  const byKind = new Map<string, { count: number; oldest: number | null }>()
  for (const item of queue.stalled) {
    const entry = byKind.get(item.kind) ?? { count: 0, oldest: null }
    entry.count += 1
    const seenAt = item.startedAt ?? item.updatedAt
    if (seenAt !== null) entry.oldest = entry.oldest === null ? seenAt : Math.min(entry.oldest, seenAt)
    byKind.set(item.kind, entry)
  }

  return [...byKind.entries()].map(([kind, entry]) => ({
    kind: 'job_stalled',
    severity: 'warning',
    dedupeKey: `job:${kind}:stalled`,
    title: `작업이 멈춘 것 같습니다: ${kind}`,
    body: `${kind} 작업 ${entry.count}건의 리스가 만료되었습니다. 워커가 다시 집어갈 때까지 기다리거나 작업을 재시작해 주세요.`,
    metadata: { kind, count: entry.count, oldestStartedAt: entry.oldest },
    cooldownMs: ALERT_COOLDOWNS.job_stalled,
  }))
}

function backupFindings(db: Db, now: number): AlertFinding[] {
  const findings: AlertFinding[] = []
  const latest = getLatestBackupLog(db)
  const lastSuccess = getLatestBackupLog(db, true)

  if (latest?.error) {
    findings.push({
      kind: 'backup_failed',
      severity: 'warning',
      dedupeKey: 'backup:failed',
      title: '데이터베이스 백업 실패',
      body: `마지막 백업이 실패했습니다: ${latest.error}. 15분 뒤 다시 시도합니다.`,
      metadata: { backupId: latest.id, error: latest.error },
      cooldownMs: ALERT_COOLDOWNS.backup_failed,
    })
  }

  if (!lastSuccess || now - lastSuccess.createdAt >= BACKUP_STALE_MS) {
    findings.push({
      kind: 'backup_missing',
      severity: 'warning',
      dedupeKey: 'backup:missing',
      title: '데이터베이스 백업이 오래되었습니다',
      body: lastSuccess
        ? `마지막 성공 백업이 ${Math.floor((now - lastSuccess.createdAt) / HOUR)}시간 전입니다. 백업 작업을 확인해 주세요.`
        : '성공한 백업 기록이 없습니다. 백업 작업을 확인해 주세요.',
      metadata: { lastSuccessAt: lastSuccess?.createdAt ?? null },
      cooldownMs: ALERT_COOLDOWNS.backup_missing,
    })
  }

  return findings
}

function integrityFinding(db: Db, now: number): AlertFinding | null {
  const integrity = databaseIntegrity(db, now)
  if (integrity === 'ok') return null
  return {
    kind: 'db_integrity',
    severity: 'critical',
    dedupeKey: 'db:integrity',
    title: '데이터베이스 무결성 검사 실패',
    body: `SQLite quick_check 결과가 "${integrity}"입니다. 백업을 확인하고 복구를 검토해 주세요.`,
    metadata: { integrity },
    cooldownMs: ALERT_COOLDOWNS.db_integrity,
  }
}

function restartFinding(db: Db, now: number): AlertFinding | null {
  const boots = countWorkerInstancesSince(db, now - RESTART_WINDOW_MS)
  if (boots < RESTART_THRESHOLD) return null
  return {
    kind: 'restart_loop',
    severity: 'warning',
    dedupeKey: 'worker:restart_loop',
    title: '워커가 반복해서 재시작합니다',
    body: `최근 1시간 동안 워커가 ${boots}번 시작되었습니다. 컨테이너 로그와 메모리 사용량을 확인해 주세요.`,
    metadata: { boots, windowMinutes: 60 },
    cooldownMs: ALERT_COOLDOWNS.restart_loop,
  }
}

function mutationFindings(db: Db): AlertFinding[] {
  const rows = db
    .query<
      {
        id: string
        kind: string
        errorCode: string | null
        errorMessage: string | null
        attempts: number
        maxAttempts: number
      },
      []
    >(
      `SELECT id, kind, error_code AS errorCode, error_message AS errorMessage,
              attempts, max_attempts AS maxAttempts
       FROM file_mutations
       WHERE state = 'blocked'
          OR (state = 'failed_retryable' AND attempts >= max_attempts)
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all()

  return rows.map((row) => ({
    kind: 'mutation_failed',
    severity: 'critical',
    dedupeKey: `mutation:${row.id}:failed`,
    title: `파일 작업 실패: ${row.kind}`,
    body:
      row.errorMessage ??
      `파일 ${row.kind} 작업이 ${row.attempts}/${row.maxAttempts}회 시도 후 중단되었습니다.`,
    metadata: {
      mutationId: row.id,
      mutationKind: row.kind,
      errorCode: row.errorCode,
      attempts: row.attempts,
    },
    cooldownMs: ALERT_COOLDOWNS.mutation_failed,
  }))
}

/**
 * Every check reads the data the rest of the system already writes. A finding
 * carries the dedupe key and cooldown; the evaluator owns persistence and
 * delivery, so a check never writes to the database.
 */
export async function collectAlertFindings(
  db: Db,
  config: WorkerConfig,
  now = Date.now(),
): Promise<AlertFinding[]> {
  const findings: AlertFinding[] = [
    ...(await libraryFindings(db, config)),
    ...(await diskFindings(config)),
    ...stalledFindings(db, config, now),
    ...backupFindings(db, now),
    ...mutationFindings(db),
  ]

  const gpu = gpuFinding(db, now)
  if (gpu) findings.push(gpu)
  const integrity = integrityFinding(db, now)
  if (integrity) findings.push(integrity)
  const restart = restartFinding(db, now)
  if (restart) findings.push(restart)

  return findings
}
