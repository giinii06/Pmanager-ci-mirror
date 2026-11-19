/**
 * The saved-filter vocabulary. A filter tree is data the client sends and the
 * server turns into SQL, so every field, operator and value shape is declared
 * here once and both the validator and the compiler read this table.
 */

import { LIBRARY_HEALTH_STATES } from './domain'

export const FILTER_FIELDS = [
  'kind',
  'library',
  'folder',
  'tag',
  'name',
  'takenAt',
  'indexedAt',
  'sizeBytes',
  'durationMs',
  'width',
  'height',
  'viewCount',
  'watchTimeMs',
  'voteCount',
  'rate',
  'lastPlayedAt',
  'bookmarked',
  'duplicate',
  'ai',
  'libraryHealth',
] as const

export type FilterField = (typeof FILTER_FIELDS)[number]

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'in',
  'contains',
  'between',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'any',
  'all',
  'none',
] as const

export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** The pipeline stage whose artifacts a filter can look for. */
export const AI_STAGES = ['transcript', 'translation', 'scenes', 'embedding'] as const
export type AiStage = (typeof AI_STAGES)[number]

/** `transcript:present` means the stage has a row for the asset's current version. */
export const AI_FILTER_VALUES = [
  'transcript:present',
  'transcript:absent',
  'translation:present',
  'translation:absent',
  'scenes:present',
  'scenes:absent',
  'embedding:present',
  'embedding:absent',
] as const
export type AiFilterValue = (typeof AI_FILTER_VALUES)[number]

export type FilterValue = string | number | boolean | string[] | number[] | [number, number]

export type FilterNode =
  | { type: 'and'; children: FilterNode[] }
  | { type: 'or'; children: FilterNode[] }
  | { type: 'not'; child: FilterNode }
  | { type: 'cond'; field: FilterField; operator: FilterOperator; value: FilterValue }

export interface FilterTree {
  version: 1
  root: FilterNode
}

export interface FieldSpec {
  operators: readonly FilterOperator[]
  /** The scalar a comparison binds. `in`/`any`/`all`/`none` bind a list of these. */
  value: 'string' | 'number' | 'boolean'
  enum?: readonly string[]
}

export const FILTER_LIMITS = { depth: 5, nodes: 50, list: 100 } as const

/** Longest string a filter may compare or search for. */
export const FILTER_TEXT_LIMIT = 200

const COMPARE: readonly FilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between']
const IDENTITY: readonly FilterOperator[] = ['eq', 'neq', 'in']

export const FIELD_SPECS: Record<FilterField, FieldSpec> = {
  kind: { operators: IDENTITY, value: 'string', enum: ['image', 'video'] },
  library: { operators: IDENTITY, value: 'string' },
  folder: { operators: IDENTITY, value: 'string' },
  tag: { operators: ['any', 'all', 'none'], value: 'string' },
  name: { operators: ['contains', 'eq', 'neq'], value: 'string' },
  takenAt: { operators: COMPARE, value: 'number' },
  indexedAt: { operators: COMPARE, value: 'number' },
  sizeBytes: { operators: COMPARE, value: 'number' },
  durationMs: { operators: COMPARE, value: 'number' },
  width: { operators: COMPARE, value: 'number' },
  height: { operators: COMPARE, value: 'number' },
  viewCount: { operators: COMPARE, value: 'number' },
  watchTimeMs: { operators: COMPARE, value: 'number' },
  voteCount: { operators: COMPARE, value: 'number' },
  rate: { operators: [...COMPARE, 'isNull'], value: 'number' },
  lastPlayedAt: { operators: [...COMPARE, 'isNull'], value: 'number' },
  bookmarked: { operators: ['eq'], value: 'boolean' },
  duplicate: { operators: ['eq', 'neq'], value: 'string', enum: ['exact', 'similar'] },
  ai: { operators: ['eq', 'neq'], value: 'string', enum: AI_FILTER_VALUES },
  libraryHealth: { operators: IDENTITY, value: 'string', enum: LIBRARY_HEALTH_STATES },
}

export type FilterParseResult =
  | { ok: true; tree: FilterTree }
  | { ok: false; error: string }

class FilterParseError extends Error {}

function asRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new FilterParseError(`${path} must be an object`)
  }
  return input as Record<string, unknown>
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new FilterParseError(`${path}.${key} is not part of a filter node`)
  }
}

function isFilterField(value: string): value is FilterField {
  return (FILTER_FIELDS as readonly string[]).includes(value)
}

function isFilterOperator(value: string): value is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(value)
}

function readScalar(spec: FieldSpec, value: unknown, path: string): string | number | boolean {
  switch (spec.value) {
    case 'string':
      if (typeof value !== 'string') throw new FilterParseError(`${path} must be a string`)
      if (value.length === 0) throw new FilterParseError(`${path} must not be empty`)
      if (value.length > FILTER_TEXT_LIMIT) {
        throw new FilterParseError(`${path} is longer than ${FILTER_TEXT_LIMIT} characters`)
      }
      if (spec.enum && !spec.enum.includes(value)) {
        throw new FilterParseError(`${path} must be one of ${spec.enum.join(', ')}`)
      }
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new FilterParseError(`${path} must be a finite number`)
      }
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw new FilterParseError(`${path} must be true or false`)
      return value
  }
}

function numericAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FilterParseError(`${path} must be a finite number`)
  }
  return value
}

function readValue(
  spec: FieldSpec,
  operator: FilterOperator,
  value: unknown,
  path: string,
): FilterValue {
  switch (operator) {
    case 'isNull':
      if (typeof value !== 'boolean') {
        throw new FilterParseError(`${path} must be true or false for isNull`)
      }
      return value
    case 'between': {
      if (spec.value !== 'number') {
        throw new FilterParseError(`${path} only accepts a numeric range`)
      }
      if (!Array.isArray(value) || value.length !== 2) {
        throw new FilterParseError(`${path} must be a [low, high] pair`)
      }
      return [numericAt(value[0], `${path}[0]`), numericAt(value[1], `${path}[1]`)]
    }
    case 'in':
    case 'any':
    case 'all':
    case 'none': {
      if (!Array.isArray(value)) throw new FilterParseError(`${path} must be an array`)
      if (value.length === 0) throw new FilterParseError(`${path} must not be empty`)
      if (value.length > FILTER_LIMITS.list) {
        throw new FilterParseError(`${path} has more than ${FILTER_LIMITS.list} entries`)
      }
      const items = value.map((item, index) => readScalar(spec, item, `${path}[${index}]`))
      // readScalar already pinned every item to the field's scalar type.
      return spec.value === 'number' ? (items as number[]) : (items as string[])
    }
    default:
      return readScalar(spec, value, path)
  }
}

function readCondition(record: Record<string, unknown>, path: string): FilterNode {
  requireOnlyKeys(record, ['type', 'field', 'operator', 'value'], path)
  const field = record.field
  if (typeof field !== 'string' || !isFilterField(field)) {
    throw new FilterParseError(`${path}.field is not a filter field`)
  }
  const spec = FIELD_SPECS[field]
  const operator = record.operator
  if (typeof operator !== 'string' || !isFilterOperator(operator) || !spec.operators.includes(operator)) {
    throw new FilterParseError(`${path}.operator is not allowed on ${field}`)
  }
  return {
    type: 'cond',
    field,
    operator,
    value: readValue(spec, operator, record.value, `${path}.value`),
  }
}

function readNode(
  input: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): FilterNode {
  if (depth > FILTER_LIMITS.depth) {
    throw new FilterParseError(`${path} nests deeper than ${FILTER_LIMITS.depth}`)
  }
  budget.nodes += 1
  if (budget.nodes > FILTER_LIMITS.nodes) {
    throw new FilterParseError(`the filter has more than ${FILTER_LIMITS.nodes} nodes`)
  }

  const record = asRecord(input, path)
  switch (record.type) {
    case 'and':
    case 'or': {
      requireOnlyKeys(record, ['type', 'children'], path)
      if (!Array.isArray(record.children)) throw new FilterParseError(`${path}.children must be an array`)
      if (record.children.length === 0) throw new FilterParseError(`${path}.children must not be empty`)
      return {
        type: record.type,
        children: record.children.map((child, index) =>
          readNode(child, `${path}.children[${index}]`, depth + 1, budget),
        ),
      }
    }
    case 'not':
      requireOnlyKeys(record, ['type', 'child'], path)
      return { type: 'not', child: readNode(record.child, `${path}.child`, depth + 1, budget) }
    case 'cond':
      return readCondition(record, path)
    default:
      throw new FilterParseError(`${path}.type must be "and", "or", "not" or "cond"`)
  }
}

/**
 * Turns untrusted JSON into a filter tree. The API validates request bodies with
 * it and the database validates a stored album filter with the same function, so
 * a tree that compiles is a tree that passed exactly one set of rules.
 */
export function parseFilterTree(input: unknown): FilterParseResult {
  try {
    const record = asRecord(input, 'filter')
    requireOnlyKeys(record, ['version', 'root'], 'filter')
    if (record.version !== 1) throw new FilterParseError('filter.version must be 1')
    const root = readNode(record.root, 'filter.root', 1, { nodes: 0 })
    return { ok: true, tree: { version: 1, root } }
  } catch (error) {
    if (error instanceof FilterParseError) return { ok: false, error: error.message }
    throw error
  }
}
