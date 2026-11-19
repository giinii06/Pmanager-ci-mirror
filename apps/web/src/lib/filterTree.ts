/**
 * The album editor's bounded view of a saved filter. The builder can express one
 * positive group plus one excluded group, and this module is the only place that
 * turns that shape into a tree and back. One encoder and one decoder means a
 * tree either round-trips exactly or is reported as unreadable; there is no
 * third state where a row disappears on save.
 */

import {
  AI_FILTER_VALUES,
  LIBRARY_HEALTH_STATES,
  type AssetKind,
  type FilterField,
  type FilterNode,
  type FilterOperator,
  type FilterTree,
  type FilterValue,
} from '@mediavault/shared'
import { randomToken } from './random'

export type RuleControl =
  | 'kind'
  | 'tag'
  | 'folder'
  | 'library'
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'duplicate'
  | 'ai'
  | 'libraryHealth'

export interface FieldDef {
  label: string
  operators: readonly FilterOperator[]
  control: RuleControl
  /** Multiplies the typed number on its way into the tree. */
  scale?: number
  unit?: string
}

export const FIELD_DEFS: Partial<Record<FilterField, FieldDef>> = {
  kind: { label: '종류', operators: ['eq'], control: 'kind' },
  tag: { label: '태그', operators: ['any', 'all', 'none'], control: 'tag' },
  folder: { label: '폴더', operators: ['eq'], control: 'folder' },
  library: { label: '라이브러리', operators: ['eq'], control: 'library' },
  name: { label: '이름', operators: ['contains'], control: 'text' },
  width: { label: '가로', operators: ['gte', 'lte', 'between'], control: 'number', unit: 'px' },
  height: { label: '세로', operators: ['gte', 'lte', 'between'], control: 'number', unit: 'px' },
  durationMs: {
    label: '길이',
    operators: ['gte', 'lte', 'between'],
    control: 'number',
    unit: '초',
    scale: 1000,
  },
  sizeBytes: {
    label: '크기',
    operators: ['gte', 'lte', 'between'],
    control: 'number',
    unit: 'MB',
    scale: 1024 * 1024,
  },
  takenAt: { label: '촬영일', operators: ['between', 'gte', 'lte'], control: 'date' },
  viewCount: { label: '조회수', operators: ['gte', 'lte'], control: 'number', unit: '회' },
  voteCount: { label: 'Vote', operators: ['gte', 'lte'], control: 'number', unit: '회' },
  rate: { label: 'Rate', operators: ['gte', 'lte'], control: 'number', unit: '%' },
  lastPlayedAt: {
    label: '마지막 재생',
    operators: ['gte', 'lte', 'between', 'isNull'],
    control: 'date',
  },
  bookmarked: { label: '북마크', operators: ['eq'], control: 'boolean' },
  duplicate: { label: '중복', operators: ['eq', 'neq'], control: 'duplicate' },
  ai: { label: 'AI 산출물', operators: ['eq', 'neq'], control: 'ai' },
  libraryHealth: { label: '라이브러리 상태', operators: ['eq'], control: 'libraryHealth' },
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: '같음',
  neq: '다름',
  in: '포함',
  contains: '포함',
  between: '사이',
  gt: '초과',
  gte: '이상',
  lt: '미만',
  lte: '이하',
  isNull: '값 없음',
  any: '하나라도 포함',
  all: '모두 포함',
  none: '하나도 없음',
}

/** The builder's field order. Object key order is the order the select renders. */
export const BUILDER_FIELDS: ReadonlyArray<{ field: FilterField; def: FieldDef }> = (
  Object.keys(FIELD_DEFS) as FilterField[]
).flatMap((field) => {
  const def = FIELD_DEFS[field]
  return def ? [{ field, def }] : []
})

export const ENUM_LABELS: Record<string, string> = {
  image: '사진',
  video: '동영상',
  exact: '완전히 같은 파일',
  similar: '비슷한 파일',
  'transcript:present': '자막 있음',
  'transcript:absent': '자막 없음',
  'translation:present': '번역 있음',
  'translation:absent': '번역 없음',
  'scenes:present': '장면 있음',
  'scenes:absent': '장면 없음',
  'embedding:present': '임베딩 있음',
  'embedding:absent': '임베딩 없음',
  ONLINE: '정상',
  DEGRADED: '주의',
  OFFLINE: '오프라인',
  UNVERIFIED: '확인 전',
}

export const ENUM_OPTIONS: Partial<Record<RuleControl, readonly string[]>> = {
  kind: ['image', 'video'],
  duplicate: ['exact', 'similar'],
  ai: AI_FILTER_VALUES,
  libraryHealth: LIBRARY_HEALTH_STATES,
}

/** A row's control values, kept as the user typed them so a partial number survives. */
export type RuleValue = string | string[] | boolean

export interface FilterRule {
  key: string
  field: FilterField
  operator: FilterOperator
  value: RuleValue
  /** Upper bound for `between`, in the same unit as `value`. */
  upper?: string
}

export interface FilterDraft {
  match: 'all' | 'any'
  rules: FilterRule[]
  none: FilterRule[]
}

export interface RuleProblem {
  key: string
  message: string
}

export const EMPTY_DRAFT: FilterDraft = { match: 'all', rules: [], none: [] }

export function draftRuleCount(draft: FilterDraft): number {
  return draft.rules.length + draft.none.length
}

function defaultRuleValue(control: RuleControl): RuleValue {
  if (control === 'tag') return []
  if (control === 'boolean') return true
  return ''
}

/** A fresh row for `field`, or null when the builder has no control for it. */
export function newRule(field: FilterField = 'kind'): FilterRule | null {
  const def = FIELD_DEFS[field]
  if (!def) return null
  return {
    key: randomToken(8),
    field,
    operator: def.operators[0] ?? 'eq',
    value: defaultRuleValue(def.control),
  }
}

/** Re-points an existing row at a different field, resetting operator and value. */
export function changeRuleField(rule: FilterRule, field: FilterField): FilterRule {
  const def = FIELD_DEFS[field]
  if (!def) return rule
  return {
    key: rule.key,
    field,
    operator: def.operators[0] ?? 'eq',
    value: defaultRuleValue(def.control),
  }
}

/** Keeps a typed value only when the new operator reads it the same way. */
export function changeRuleOperator(rule: FilterRule, operator: FilterOperator): FilterRule {
  const def = FIELD_DEFS[rule.field]
  if (!def) return rule
  const wasList = rule.operator === 'any' || rule.operator === 'all' || rule.operator === 'none'
  const isList = operator === 'any' || operator === 'all' || operator === 'none'
  if (wasList !== isList || operator === 'isNull' || rule.operator === 'isNull') {
    return { key: rule.key, field: rule.field, operator, value: defaultRuleValue(def.control) }
  }
  if (operator === 'between' && !rule.upper) {
    return { ...rule, operator, upper: '' }
  }
  return { ...rule, operator }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Epoch ms to the `datetime-local` value the browser renders, in local time. */
export function toLocalInput(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A `datetime-local` value as epoch ms. A date-time without an offset is local. */
export function fromLocalInput(text: string): number | null {
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

function numberFrom(text: string, def: FieldDef): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return null
  return def.scale ? Math.round(value * def.scale) : value
}

function scalarFrom(def: FieldDef, text: string): FilterValue | null {
  if (def.control === 'date') return fromLocalInput(text)
  if (def.control === 'number') return numberFrom(text, def)
  const trimmed = text.trim()
  return trimmed ? trimmed : null
}

function displayScalar(def: FieldDef, value: FilterValue): string {
  if (typeof value === 'number') {
    if (def.control === 'date') return toLocalInput(value)
    return String(def.scale ? Number((value / def.scale).toFixed(3)) : value)
  }
  return String(value)
}

export type RuleCond = { ok: true; cond: FilterNode } | { ok: false; message: string }

/** One row as the condition the API will parse. */
export function ruleToCond(rule: FilterRule): RuleCond {
  const def = FIELD_DEFS[rule.field]
  if (!def) return { ok: false, message: '이 편집기에서 다루지 않는 조건입니다.' }
  if (!def.operators.includes(rule.operator)) {
    return { ok: false, message: `${def.label}에는 쓸 수 없는 연산자입니다.` }
  }

  const cond = (operator: FilterOperator, value: FilterValue): RuleCond => ({
    ok: true,
    cond: { type: 'cond', field: rule.field, operator, value },
  })

  if (rule.operator === 'isNull') return cond('isNull', true)

  if (rule.operator === 'between') {
    const low = scalarFrom(def, String(rule.value))
    const high = scalarFrom(def, rule.upper ?? '')
    if (low === null || high === null || typeof low !== 'number' || typeof high !== 'number') {
      return { ok: false, message: `${def.label} 범위의 두 값을 채우세요.` }
    }
    return cond('between', [low, high])
  }

  if (rule.operator === 'any' || rule.operator === 'all' || rule.operator === 'none') {
    const list = Array.isArray(rule.value) ? rule.value.filter((item) => item.length > 0) : []
    if (list.length === 0) return { ok: false, message: `${def.label}을(를) 하나 이상 고르세요.` }
    return cond(rule.operator, list)
  }

  if (def.control === 'boolean') {
    if (typeof rule.value !== 'boolean') {
      return { ok: false, message: `${def.label} 값을 고르세요.` }
    }
    return cond(rule.operator, rule.value)
  }

  const scalar = scalarFrom(def, String(rule.value))
  if (scalar === null) {
    return {
      ok: false,
      message:
        def.control === 'number'
          ? `${def.label}에 숫자를 입력하세요.`
          : def.control === 'date'
            ? `${def.label} 날짜를 고르세요.`
            : `${def.label} 값을 입력하세요.`,
    }
  }
  return cond(rule.operator, scalar)
}

export function draftProblems(draft: FilterDraft): RuleProblem[] {
  const problems: RuleProblem[] = []
  for (const rule of [...draft.rules, ...draft.none]) {
    const result = ruleToCond(rule)
    if (!result.ok) problems.push({ key: rule.key, message: result.message })
  }
  return problems
}

function condsOf(rules: FilterRule[]): FilterNode[] | null {
  const nodes: FilterNode[] = []
  for (const rule of rules) {
    const result = ruleToCond(rule)
    if (!result.ok) return null
    nodes.push(result.cond)
  }
  return nodes
}

/**
 * The draft as a tree, or null when there is nothing to save. Positive rows
 * become one and/or group, excluded rows become `not(or(...))`, and the root
 * conjoins whichever of the two exist.
 */
export function treeFromDraft(draft: FilterDraft): FilterTree | null {
  const children: FilterNode[] = []
  if (draft.rules.length > 0) {
    const conds = condsOf(draft.rules)
    if (!conds) return null
    children.push({ type: draft.match === 'all' ? 'and' : 'or', children: conds })
  }
  if (draft.none.length > 0) {
    const conds = condsOf(draft.none)
    if (!conds) return null
    children.push({ type: 'not', child: { type: 'or', children: conds } })
  }
  if (children.length === 0) return null
  return { version: 1, root: { type: 'and', children } }
}

function ruleFromCond(node: FilterNode): FilterRule | null {
  if (node.type !== 'cond') return null
  const def = FIELD_DEFS[node.field]
  if (!def) return null
  if (!def.operators.includes(node.operator)) return null
  const value = node.value
  const base = { key: randomToken(8), field: node.field, operator: node.operator }

  if (node.operator === 'isNull') return { ...base, value: true }

  if (node.operator === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return null
    const [low, high] = value
    if (typeof low !== 'number' || typeof high !== 'number') return null
    return { ...base, value: displayScalar(def, low), upper: displayScalar(def, high) }
  }

  if (node.operator === 'any' || node.operator === 'all' || node.operator === 'none') {
    if (!Array.isArray(value)) return null
    return { ...base, value: value.map((item) => String(item)) }
  }

  if (typeof value === 'boolean') return { ...base, value }
  if (typeof value === 'string' || typeof value === 'number') {
    return { ...base, value: displayScalar(def, value) }
  }
  return null
}

function rulesOf(node: FilterNode): FilterRule[] | null {
  if (node.type !== 'and' && node.type !== 'or') return null
  if (node.children.length === 0) return null
  const rules: FilterRule[] = []
  for (const child of node.children) {
    const rule = ruleFromCond(child)
    if (!rule) return null
    rules.push(rule)
  }
  return rules
}

/**
 * Reads a stored tree back into the builder. Only the exact shape
 * `and([and|or(...), not(or(...))?])` is understood; anything else returns null
 * so the editor starts empty and says so instead of showing a partial filter.
 */
export function draftFromTree(tree: FilterTree): FilterDraft | null {
  const root = tree.root
  if (root.type !== 'and') return null

  let positive: FilterNode | null = null
  let negative: FilterNode | null = null
  for (const child of root.children) {
    if (child.type === 'not') {
      if (negative || child.child.type !== 'or') return null
      negative = child.child
      continue
    }
    if (child.type === 'and' || child.type === 'or') {
      if (positive) return null
      positive = child
      continue
    }
    return null
  }

  const rules = positive ? rulesOf(positive) : []
  const none = negative ? rulesOf(negative) : []
  if (!rules || !none) return null
  if (rules.length === 0 && none.length === 0) return null

  return { match: positive?.type === 'or' ? 'any' : 'all', rules, none }
}

/** The gallery filter a page is already showing, as a draft worth saving. */
export function draftFromAssetQuery(query: {
  kind?: AssetKind
  tagId?: string
  folderId?: string
  q?: string
}): FilterDraft {
  const rules: FilterRule[] = []
  const push = (field: FilterField, operator: FilterOperator, value: RuleValue): void => {
    rules.push({ key: randomToken(8), field, operator, value })
  }
  if (query.kind) push('kind', 'eq', query.kind)
  if (query.tagId) push('tag', 'any', [query.tagId])
  if (query.folderId) push('folder', 'eq', query.folderId)
  if (query.q) push('name', 'contains', query.q)
  return { match: 'all', rules, none: [] }
}
