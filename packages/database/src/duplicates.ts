import { createHash } from 'node:crypto'
import type { SQLQueryBindings } from 'bun:sqlite'
import type { DuplicateGroupKind, DuplicateGroupState } from '@mediavault/shared'
import type { Db } from './db'

type Params = SQLQueryBindings[]

/**
 * A group is only worth showing while two of its members are still live. A
 * soft-deleted partner leaves the row behind until the next scan rebuilds it,
 * so the read path refuses to present a group of one.
 */
const liveMembers = (group: string) => `(
  SELECT COUNT(*) FROM duplicate_group_members m
  JOIN assets a ON a.id = m.asset_id
  WHERE m.group_id = ${group} AND a.deleted_at IS NULL
)`

const GROUP_SELECT = `
  SELECT g.id, g.kind, g.fingerprint, g.state,
         g.created_at AS createdAt, g.updated_at AS updatedAt
  FROM duplicate_groups g`

const MEMBER_SELECT = `
  SELECT m.group_id AS groupId, m.asset_id AS assetId, m.confidence,
         m.same_inode AS sameInode,
         a.filename, a.kind, a.size_bytes AS sizeBytes, a.width, a.height,
         a.duration_ms AS durationMs, a.taken_at AS takenAt,
         a.file_version AS fileVersion, a.poster_version AS posterVersion,
         l.name AS libraryName, l.root_path AS rootPath,
         a.relative_path AS relativePath
  FROM duplicate_group_members m
  JOIN assets a ON a.id = m.asset_id
  JOIN libraries l ON l.id = a.library_id`

export interface FileFingerprintInput {
  assetId: string
  fileVersion: number
  sizeBytes: number
  quickHash: string | null
  fullHash: string | null
  deviceId: number | null
  inode: number | null
  algo?: string
}

export interface FileFingerprintRecord {
  assetId: string
  fileVersion: number
  sizeBytes: number
  quickHash: string | null
  fullHash: string | null
  algo: string
  deviceId: number | null
  inode: number | null
  calculatedAt: number
}

export interface DuplicateCandidate {
  id: string
  libraryId: string
  rootPath: string
  relativePath: string
  fileVersion: number
  sizeBytes: number
  mtimeMs: number
}

export interface DuplicateGroupMemberInput {
  assetId: string
  confidence: number
  sameInode: boolean
}

export interface DuplicateGroupInput {
  fingerprint: string
  members: DuplicateGroupMemberInput[]
}

export interface DuplicateGroupMemberRecord {
  assetId: string
  filename: string
  kind: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  libraryName: string
  rootPath: string
  relativePath: string
  fileVersion: number
  posterVersion: number
  confidence: number
  sameInode: boolean
}

export interface DuplicateGroupRecord {
  id: string
  kind: DuplicateGroupKind
  fingerprint: string
  state: DuplicateGroupState
  createdAt: number
  updatedAt: number
  memberCount: number
  totalBytes: number
  members: DuplicateGroupMemberRecord[]
}

export interface DuplicateGroupCursor {
  createdAt: number
  id: string
}

export interface ListDuplicateGroupsOptions {
  kind: DuplicateGroupKind
  /** `all` returns every state. */
  state: DuplicateGroupState | 'all'
  limit: number
  cursor?: DuplicateGroupCursor | null
}

export interface DuplicateGroupPage {
  groups: DuplicateGroupRecord[]
  nextCursor: DuplicateGroupCursor | null
}

export interface ReplaceDuplicateGroupsResult {
  created: number
  updated: number
  removed: number
}

const FINGERPRINT_SELECT = `
  SELECT asset_id AS assetId, file_version AS fileVersion, size_bytes AS sizeBytes,
         quick_hash AS quickHash, full_hash AS fullHash, algo,
         device_id AS deviceId, inode, calculated_at AS calculatedAt
  FROM file_fingerprints`

/**
 * A group's identity is derived from what it groups, so two scans of the same
 * bytes land on the same row and the reviewer's decision survives them.
 */
export function duplicateGroupId(kind: DuplicateGroupKind, fingerprint: string): string {
  return `dup_${createHash('sha256').update(`${kind}:${fingerprint}`).digest('hex').slice(0, 16)}`
}

/** The full hash alone identifies content; the size keeps a collision from merging two different files. */
export function exactFingerprint(sizeBytes: number, fullHash: string): string {
  return `sha256:${sizeBytes}:${fullHash}`
}

export function upsertFileFingerprint(
  db: Db,
  input: FileFingerprintInput,
  now: number,
): FileFingerprintRecord {
  db.query<{ assetId: string }, Params>(
    `INSERT INTO file_fingerprints (
       asset_id, file_version, size_bytes, quick_hash, full_hash, algo,
       device_id, inode, calculated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, file_version) DO UPDATE SET
       size_bytes = excluded.size_bytes,
       quick_hash = excluded.quick_hash,
       full_hash = excluded.full_hash,
       algo = excluded.algo,
       device_id = excluded.device_id,
       inode = excluded.inode,
       calculated_at = excluded.calculated_at
     RETURNING asset_id AS assetId`,
  ).get(
    input.assetId,
    input.fileVersion,
    input.sizeBytes,
    input.quickHash,
    input.fullHash,
    input.algo ?? 'sha256',
    input.deviceId,
    input.inode,
    now,
  )
  return getFileFingerprint(db, input.assetId, input.fileVersion)!
}

export function getFileFingerprint(
  db: Db,
  assetId: string,
  fileVersion: number,
): FileFingerprintRecord | null {
  return (
    db
      .query<FileFingerprintRecord, Params>(
        `${FINGERPRINT_SELECT} WHERE asset_id = ? AND file_version = ?`,
      )
      .get(assetId, fileVersion) ?? null
  )
}

/**
 * Only a shared size can produce a duplicate, so the size histogram is the
 * cheapest honest filter: a file whose size is unique in the library never
 * needs to be opened.
 */
export function duplicateCandidates(db: Db, libraryId?: string): DuplicateCandidate[] {
  const scoped = libraryId ?? null
  return db
    .query<DuplicateCandidate, Params>(
      `SELECT a.id, a.library_id AS libraryId, l.root_path AS rootPath,
              a.relative_path AS relativePath, a.file_version AS fileVersion,
              a.size_bytes AS sizeBytes, a.mtime_ms AS mtimeMs
       FROM assets a
       JOIN libraries l ON l.id = a.library_id
       WHERE a.deleted_at IS NULL
         AND a.kind IN ('image','video')
         AND (? IS NULL OR a.library_id = ?)
         AND a.size_bytes IN (
           SELECT size_bytes FROM assets
           WHERE deleted_at IS NULL AND kind IN ('image','video')
             AND (? IS NULL OR library_id = ?)
           GROUP BY size_bytes
           HAVING COUNT(*) >= 2
         )
       ORDER BY a.size_bytes, a.id`,
    )
    .all(scoped, scoped, scoped, scoped)
}

/**
 * Rebuilds the exact groups from every stored full hash, not from this scan's
 * candidates, so a group whose partner was deleted disappears and a pair split
 * across two libraries is still one group. A fingerprint belongs to one file
 * version; the join drops rows left by an older version of the same asset.
 */
export function exactDuplicateGroups(db: Db): DuplicateGroupInput[] {
  const rows = db
    .query<
      {
        sizeBytes: number
        fullHash: string
        assetId: string
        deviceId: number | null
        inode: number | null
      },
      Params
    >(
      `SELECT f.size_bytes AS sizeBytes, f.full_hash AS fullHash, f.asset_id AS assetId,
              f.device_id AS deviceId, f.inode AS inode
       FROM file_fingerprints f
       JOIN assets a ON a.id = f.asset_id AND a.file_version = f.file_version
       WHERE a.deleted_at IS NULL AND f.full_hash IS NOT NULL
       ORDER BY f.size_bytes, f.full_hash, a.id`,
    )
    .all()

  const buckets = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = exactFingerprint(row.sizeBytes, row.fullHash)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  const groups: DuplicateGroupInput[] = []
  for (const [fingerprint, members] of buckets) {
    if (members.length < 2) continue
    groups.push({
      fingerprint,
      members: members.map((member) => ({
        assetId: member.assetId,
        confidence: 1,
        sameInode: sharesInode(member, members),
      })),
    })
  }
  return groups
}

/**
 * Two rows with the same device and inode are one body of bytes on disk. An
 * unknown inode is never a match, or two unreadable files would look linked.
 */
function sharesInode(
  member: { assetId: string; deviceId: number | null; inode: number | null },
  members: Array<{ assetId: string; deviceId: number | null; inode: number | null }>,
): boolean {
  if (member.inode === null || member.deviceId === null) return false
  return members.some(
    (other) =>
      other.assetId !== member.assetId &&
      other.inode === member.inode &&
      other.deviceId === member.deviceId,
  )
}

/**
 * Replaces the whole set of groups for one kind in a single transaction. The
 * group row keeps its `state`, so a decision a reviewer already made is not
 * thrown away by the next scan; only the members are rebuilt.
 */
export function replaceDuplicateGroups(
  db: Db,
  kind: DuplicateGroupKind,
  groups: DuplicateGroupInput[],
  now: number,
): ReplaceDuplicateGroupsResult {
  return db
    .transaction((): ReplaceDuplicateGroupsResult => {
      let created = 0
      let updated = 0
      const ids: string[] = []

      const exists = db.query<{ id: string }, Params>('SELECT id FROM duplicate_groups WHERE id = ?')
      const upsert = db.query<{ id: string }, Params>(
        `INSERT INTO duplicate_groups (id, kind, fingerprint, state, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
         RETURNING id`,
      )
      const clearMembers = db.query<null, Params>(
        'DELETE FROM duplicate_group_members WHERE group_id = ?',
      )
      const insertMember = db.query<null, Params>(
        `INSERT INTO duplicate_group_members (group_id, asset_id, confidence, same_inode)
         VALUES (?, ?, ?, ?)`,
      )

      for (const group of groups) {
        const id = duplicateGroupId(kind, group.fingerprint)
        ids.push(id)
        const known = exists.get(id) !== null
        upsert.get(id, kind, group.fingerprint, now, now)
        if (known) updated += 1
        else created += 1

        clearMembers.run(id)
        for (const member of group.members) {
          insertMember.run(id, member.assetId, member.confidence, member.sameInode ? 1 : 0)
        }
      }

      const removed =
        ids.length === 0
          ? db
              .query<{ id: string }, Params>('DELETE FROM duplicate_groups WHERE kind = ? RETURNING id')
              .all(kind).length
          : db
              .query<{ id: string }, Params>(
                `DELETE FROM duplicate_groups WHERE kind = ? AND id NOT IN (${ids
                  .map(() => '?')
                  .join(',')})
                 RETURNING id`,
              )
              .all(kind, ...ids).length

      return { created, updated, removed }
    })
    .immediate()
}

export function listDuplicateGroups(
  db: Db,
  options: ListDuplicateGroupsOptions,
): DuplicateGroupPage {
  const params: Params = [options.kind]
  let where = 'WHERE g.kind = ?'
  if (options.state !== 'all') {
    where += ' AND g.state = ?'
    params.push(options.state)
  }
  if (options.cursor) {
    where += ' AND (g.created_at < ? OR (g.created_at = ? AND g.id < ?))'
    params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id)
  }
  where += ` AND ${liveMembers('g.id')} >= 2`

  const rows = db
    .query<GroupRow, Params>(
      `${GROUP_SELECT} ${where}
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT ?`,
    )
    .all(...params, options.limit + 1)

  const page = rows.slice(0, options.limit)
  const last = page.at(-1)
  return {
    groups: hydrate(db, page),
    nextCursor:
      rows.length > options.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}

export function getDuplicateGroup(db: Db, id: string): DuplicateGroupRecord | null {
  const row = db
    .query<GroupRow, Params>(`${GROUP_SELECT} WHERE g.id = ? AND ${liveMembers('g.id')} >= 2`)
    .get(id)
  if (!row) return null
  return hydrate(db, [row])[0] ?? null
}

/**
 * A reviewer can mark a group kept or ignored. There is deliberately no third
 * state: this module cannot express a delete, so no caller can reach one.
 */
export function setDuplicateGroupState(
  db: Db,
  id: string,
  state: Exclude<DuplicateGroupState, 'open'>,
  now: number,
): DuplicateGroupRecord | null {
  const row = db
    .query<{ id: string }, Params>(
      `UPDATE duplicate_groups SET state = ?, updated_at = ?
       WHERE id = ? AND ${liveMembers('duplicate_groups.id')} >= 2
       RETURNING id`,
    )
    .get(state, now, id)
  if (!row) return null
  return getDuplicateGroup(db, id)
}

interface GroupRow {
  id: string
  kind: DuplicateGroupKind
  fingerprint: string
  state: DuplicateGroupState
  createdAt: number
  updatedAt: number
}

interface MemberRow {
  groupId: string
  assetId: string
  confidence: number
  sameInode: number
  filename: string
  kind: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: number
  fileVersion: number
  posterVersion: number
  libraryName: string
  rootPath: string
  relativePath: string
}

function hydrate(db: Db, rows: GroupRow[]): DuplicateGroupRecord[] {
  if (rows.length === 0) return []
  const members = db
    .query<MemberRow, Params>(
      `${MEMBER_SELECT}
       WHERE m.group_id IN (${rows.map(() => '?').join(',')}) AND a.deleted_at IS NULL
       ORDER BY m.group_id, a.filename COLLATE NOCASE, a.id`,
    )
    .all(...rows.map((row) => row.id))

  const byGroup = new Map<string, DuplicateGroupMemberRecord[]>()
  for (const member of members) {
    const list = byGroup.get(member.groupId)
    const record: DuplicateGroupMemberRecord = {
      assetId: member.assetId,
      filename: member.filename,
      kind: member.kind,
      sizeBytes: member.sizeBytes,
      width: member.width,
      height: member.height,
      durationMs: member.durationMs,
      takenAt: member.takenAt,
      libraryName: member.libraryName,
      rootPath: member.rootPath,
      relativePath: member.relativePath,
      fileVersion: member.fileVersion,
      posterVersion: member.posterVersion,
      confidence: member.confidence,
      sameInode: member.sameInode === 1,
    }
    if (list) list.push(record)
    else byGroup.set(member.groupId, [record])
  }

  return rows.map((row) => {
    const groupMembers = byGroup.get(row.id) ?? []
    return {
      ...row,
      memberCount: groupMembers.length,
      totalBytes: groupMembers.reduce((sum, member) => sum + member.sizeBytes, 0),
      members: groupMembers,
    }
  })
}

/**
 * An automatic deletion must never proceed after its keeper vanished,
 * was scheduled for another mutation or stopped matching the target hash.
 * Both fingerprints must match the currently indexed file version.
 */
export function hasExactDuplicateKeeper(
  db: Db,
  targetId: string,
  targetVersion: number,
  keeperId: string,
  keeperVersion: number,
): boolean {
  if (targetId === keeperId) return false
  const found = db.query<{ ok: number }, Params>(
    `SELECT 1 AS ok
     FROM assets target
     JOIN file_fingerprints tf ON tf.asset_id = target.id AND tf.file_version = target.file_version
     JOIN assets keeper ON keeper.id = ?
     JOIN file_fingerprints kf ON kf.asset_id = keeper.id AND kf.file_version = keeper.file_version
     WHERE target.id = ?
       AND target.file_version = ?
       AND keeper.file_version = ?
       AND target.deleted_at IS NULL
       AND keeper.deleted_at IS NULL
       AND keeper.pending_delete_mutation_id IS NULL
       AND tf.full_hash IS NOT NULL
       AND tf.full_hash = kf.full_hash
       AND tf.size_bytes = kf.size_bytes
     LIMIT 1`,
  ).get(keeperId, targetId, targetVersion, keeperVersion)
  return found !== null
}
