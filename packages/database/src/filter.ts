import type { SQLQueryBindings } from 'bun:sqlite'
import {
  AI_STAGES,
  type AiStage,
  type FilterField,
  type FilterNode,
  type FilterOperator,
  type FilterTree,
  type FilterValue,
} from '@mediavault/shared'

type Params = SQLQueryBindings[]

export class FilterCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilterCompileError'
  }
}

export interface CompiledFilter {
  sql: string
  params: Params
}

/** A filter that names a per-user field needs the user; library-wide callers pass null. */
export interface FilterContext {
  userId: string | null
}

/**
 * The single definition of `rate`: a percentile of average watch time across all
 * rated videos. The order-by expression in `assets.ts` and this CTE have to move
 * together, so they read the same constant instead of two copies of the formula.
 */
export const RATE_RANKED_SQL = `
  WITH rated AS (
    SELECT id, CAST(watch_time_ms AS REAL) / view_count AS avg_watch
    FROM assets
    WHERE deleted_at IS NULL AND kind = 'video' AND view_count > 0 AND watch_time_ms > 0
  ),
  ranked AS (
    SELECT id,
           ROUND(
             ((RANK() OVER (ORDER BY avg_watch ASC) - 1
               + 0.5 * COUNT(*) OVER (PARTITION BY avg_watch)) * 100.0)
             / COUNT(*) OVER (),
             1
           ) AS rate
    FROM rated
  )
`

/** Escapes the LIKE wildcards so a filename search matches the characters typed. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

function text(value: FilterValue): string {
  if (typeof value !== 'string') throw new FilterCompileError('expected a string value')
  return value
}

function numeric(value: FilterValue): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FilterCompileError('expected a finite number value')
  }
  return value
}

/** A single bound value for a column whose scalar type the field spec already pinned. */
function scalar(value: FilterValue): string | number {
  return typeof value === 'string' ? value : numeric(value)
}

function flag(value: FilterValue): boolean {
  if (typeof value !== 'boolean') throw new FilterCompileError('expected a true or false value')
  return value
}

function list(value: FilterValue): string[] | number[] {
  if (!Array.isArray(value)) throw new FilterCompileError('expected a list value')
  return value
}

function range(value: FilterValue): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new FilterCompileError('expected a [low, high] pair')
  }
  return [numeric(value[0]), numeric(value[1])]
}

function requireUser(ctx: FilterContext): string {
  if (!ctx.userId) throw new FilterCompileError('this filter field needs a signed-in user')
  return ctx.userId
}

type FieldCompiler = (operator: FilterOperator, value: FilterValue, ctx: FilterContext) => CompiledFilter

const COMPARISON = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

function columnField(column: string): FieldCompiler {
  return (operator, value) => {
    switch (operator) {
      case 'eq':
      case 'neq':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return {
          sql: `${column} ${COMPARISON[operator]} ?`,
          params: [scalar(value)],
        }
      case 'between': {
        const [low, high] = range(value)
        return { sql: `${column} >= ? AND ${column} <= ?`, params: [low, high] }
      }
      case 'in': {
        const items = list(value)
        return {
          sql: `${column} IN (${placeholders(items.length)})`,
          params: [...items],
        }
      }
      default:
        throw new FilterCompileError(`operator ${operator} does not apply to ${column}`)
    }
  }
}

const nameField: FieldCompiler = (operator, value) => {
  switch (operator) {
    case 'contains':
      return { sql: "a.filename LIKE ? ESCAPE '\\'", params: [likePattern(text(value))] }
    case 'eq':
      return { sql: 'a.filename = ?', params: [text(value)] }
    case 'neq':
      return { sql: 'a.filename <> ?', params: [text(value)] }
    default:
      throw new FilterCompileError(`operator ${operator} does not apply to name`)
  }
}

// Images and videos keep separate tag tables, so a tag filter reads both.
const tagField: FieldCompiler = (operator, value) => {
  const ids = list(value)
  const inList = `IN (${placeholders(ids.length)})`
  const linked = (table: string) =>
    `EXISTS (SELECT 1 FROM ${table} t WHERE t.asset_id = a.id AND t.tag_id ${inList})`
  switch (operator) {
    case 'any':
      return {
        sql: `(${linked('asset_tags')} OR ${linked('photo_asset_tags')})`,
        params: [...ids, ...ids],
      }
    case 'all':
      return {
        sql: `((SELECT COUNT(DISTINCT t.tag_id) FROM asset_tags t
               WHERE t.asset_id = a.id AND t.tag_id ${inList})
             + (SELECT COUNT(DISTINCT t.tag_id) FROM photo_asset_tags t
               WHERE t.asset_id = a.id AND t.tag_id ${inList})) = ?`,
        params: [...ids, ...ids, ids.length],
      }
    case 'none':
      return {
        sql: `NOT (${linked('asset_tags')} OR ${linked('photo_asset_tags')})`,
        params: [...ids, ...ids],
      }
    default:
      throw new FilterCompileError(`operator ${operator} does not apply to tag`)
  }
}

const ratedMembers = (predicate: string): string =>
  `a.id IN (${RATE_RANKED_SQL} SELECT id FROM ranked WHERE ${predicate})`

const rateField: FieldCompiler = (operator, value) => {
  switch (operator) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return {
        sql: ratedMembers(`rate ${COMPARISON[operator]} ?`),
        params: [numeric(value)],
      }
    case 'between': {
      const [low, high] = range(value)
      return { sql: ratedMembers('rate >= ? AND rate <= ?'), params: [low, high] }
    }
    case 'isNull':
      // A video with no views has no rate, and `isNull: false` is its complement.
      return flag(value)
        ? { sql: `a.id NOT IN (${RATE_RANKED_SQL} SELECT id FROM ranked)`, params: [] }
        : { sql: `a.id IN (${RATE_RANKED_SQL} SELECT id FROM ranked)`, params: [] }
    default:
      throw new FilterCompileError(`operator ${operator} does not apply to rate`)
  }
}

const playedExists = (predicate: string): string =>
  `EXISTS (SELECT 1 FROM playback_progress p WHERE p.asset_id = a.id AND p.user_id = ?${predicate})`

const lastPlayedField: FieldCompiler = (operator, value, ctx) => {
  const userId = requireUser(ctx)
  switch (operator) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return {
        sql: playedExists(` AND p.updated_at ${COMPARISON[operator]} ?`),
        params: [userId, numeric(value)],
      }
    case 'between': {
      const [low, high] = range(value)
      return {
        sql: playedExists(' AND p.updated_at >= ? AND p.updated_at <= ?'),
        params: [userId, low, high],
      }
    }
    case 'isNull':
      return flag(value)
        ? { sql: `NOT ${playedExists('')}`, params: [userId] }
        : { sql: playedExists(''), params: [userId] }
    default:
      throw new FilterCompileError(`operator ${operator} does not apply to lastPlayedAt`)
  }
}

const bookmarkedField: FieldCompiler = (operator, value, ctx) => {
  const userId = requireUser(ctx)
  if (operator !== 'eq') {
    throw new FilterCompileError(`operator ${operator} does not apply to bookmarked`)
  }
  const exists = `EXISTS (SELECT 1 FROM video_bookmarks b WHERE b.asset_id = a.id AND b.user_id = ?)`
  return flag(value)
    ? { sql: exists, params: [userId] }
    : { sql: `NOT ${exists}`, params: [userId] }
}

const duplicateField: FieldCompiler = (operator, value) => {
  const exists = `EXISTS (SELECT 1 FROM duplicate_group_members m
    JOIN duplicate_groups g ON g.id = m.group_id
    WHERE m.asset_id = a.id AND g.state = 'open' AND g.kind = ?)`
  switch (operator) {
    case 'eq':
      return { sql: exists, params: [text(value)] }
    case 'neq':
      return { sql: `NOT ${exists}`, params: [text(value)] }
    default:
      throw new FilterCompileError(`operator ${operator} does not apply to duplicate`)
  }
}

const AI_TABLES: Record<AiStage, string> = {
  transcript: 'transcripts',
  translation: 'translations',
  scenes: 'video_scenes',
  embedding: 'video_embeddings',
}

const aiField: FieldCompiler = (operator, value) => {
  if (operator !== 'eq' && operator !== 'neq') {
    throw new FilterCompileError(`operator ${operator} does not apply to ai`)
  }
  const [stage, state] = text(value).split(':')
  if (!stage || !(AI_STAGES as readonly string[]).includes(stage)) {
    throw new FilterCompileError(`unknown ai stage ${stage}`)
  }
  if (state !== 'present' && state !== 'absent') {
    throw new FilterCompileError(`unknown ai state ${state}`)
  }
  // The table name comes from the map above, never from the filter value.
  const exists = `EXISTS (SELECT 1 FROM ${AI_TABLES[stage as AiStage]} t
    WHERE t.asset_id = a.id AND t.file_version = a.file_version)`
  const wantsPresent = (state === 'present') === (operator === 'eq')
  return { sql: wantsPresent ? exists : `NOT ${exists}`, params: [] }
}

const HEALTH_STATE = `COALESCE((SELECT h.state FROM library_health h
  WHERE h.library_id = a.library_id), 'UNVERIFIED')`

const libraryHealthField: FieldCompiler = (operator, value) => {
  switch (operator) {
    case 'eq':
      return { sql: `${HEALTH_STATE} = ?`, params: [text(value)] }
    case 'neq':
      return { sql: `${HEALTH_STATE} <> ?`, params: [text(value)] }
    case 'in': {
      const items = list(value)
      return { sql: `${HEALTH_STATE} IN (${placeholders(items.length)})`, params: [...items] }
    }
    default:
      throw new FilterCompileError(`operator ${operator} does not apply to libraryHealth`)
  }
}

/**
 * One entry per filter field. `satisfies` makes adding a field to the registry
 * without SQL a compile error rather than a filter that quietly matches nothing.
 */
const FIELD_COMPILERS = {
  kind: columnField('a.kind'),
  library: columnField('a.library_id'),
  folder: columnField('a.folder_id'),
  tag: tagField,
  name: nameField,
  takenAt: columnField('a.taken_at'),
  indexedAt: columnField('a.indexed_at'),
  sizeBytes: columnField('a.size_bytes'),
  durationMs: columnField('a.duration_ms'),
  width: columnField('a.width'),
  height: columnField('a.height'),
  viewCount: columnField('a.view_count'),
  watchTimeMs: columnField('a.watch_time_ms'),
  voteCount: columnField('a.vote_count'),
  rate: rateField,
  lastPlayedAt: lastPlayedField,
  bookmarked: bookmarkedField,
  duplicate: duplicateField,
  ai: aiField,
  libraryHealth: libraryHealthField,
} satisfies Record<FilterField, FieldCompiler>

function join(children: FilterNode[], glue: 'AND' | 'OR', ctx: FilterContext, empty: string): CompiledFilter {
  if (children.length === 0) return { sql: empty, params: [] }
  const parts = children.map((child) => compileNode(child, ctx))
  return {
    sql: parts.map((part) => `(${part.sql})`).join(` ${glue} `),
    params: parts.flatMap((part) => part.params),
  }
}

function compileNode(node: FilterNode, ctx: FilterContext): CompiledFilter {
  switch (node.type) {
    case 'and':
      return join(node.children, 'AND', ctx, '1 = 1')
    case 'or':
      return join(node.children, 'OR', ctx, '1 = 0')
    case 'not': {
      const inner = compileNode(node.child, ctx)
      return { sql: `NOT (${inner.sql})`, params: inner.params }
    }
    case 'cond':
      return FIELD_COMPILERS[node.field](node.operator, node.value, ctx)
  }
}

/**
 * Compiles a validated tree into a parenthesized boolean expression over
 * `assets a`. Every value is bound; column names come only from the maps above.
 */
export function compileFilter(tree: FilterTree, ctx: FilterContext): CompiledFilter {
  const compiled = compileNode(tree.root, ctx)
  return { sql: `(${compiled.sql})`, params: compiled.params }
}
