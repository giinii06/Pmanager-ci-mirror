import { useQuery } from '@tanstack/react-query'
import { Minus, Plus, X } from 'lucide-react'
import type { FilterOperator, FolderDTO, LibraryDTO, TagSummaryDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import {
  BUILDER_FIELDS,
  ENUM_LABELS,
  ENUM_OPTIONS,
  OPERATOR_LABELS,
  changeRuleField,
  changeRuleOperator,
  newRule,
  type FieldDef,
  type FilterDraft,
  type FilterRule,
  type RuleProblem,
} from '../lib/filterTree'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

const SELECT =
  'h-8 shrink-0 rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-ink transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none'

interface Lookups {
  tags: TagSummaryDTO[]
  libraries: LibraryDTO[]
  folders: FolderDTO[]
}

function ScalarInput({
  def,
  value,
  label,
  onChange,
}: {
  def: FieldDef
  value: string
  label: string
  onChange: (next: string) => void
}) {
  if (def.control === 'date') {
    return (
      <Input
        type="datetime-local"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-[196px] text-[12px]"
      />
    )
  }
  if (def.control === 'number') {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          type="number"
          step="any"
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-24 text-[12px] tabular-nums"
        />
        {def.unit ? <span className="text-[11px] text-faint">{def.unit}</span> : null}
      </span>
    )
  }
  return (
    <Input
      value={value}
      aria-label={label}
      placeholder="값"
      onChange={(event) => onChange(event.target.value)}
      className="h-8 w-44 text-[12px]"
    />
  )
}

function TagValue({ rule, tags, onChange }: { rule: FilterRule; tags: TagSummaryDTO[]; onChange: (next: FilterRule) => void }) {
  const selected = Array.isArray(rule.value) ? rule.value : []
  const remaining = tags.filter((tag) => !selected.includes(tag.id))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((id) => {
        const tag = tags.find((item) => item.id === id)
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11.5px] text-ink"
          >
            {tag?.name ?? '없는 태그'}
            <button
              type="button"
              aria-label={`${tag?.name ?? id} 제거`}
              onClick={() => onChange({ ...rule, value: selected.filter((item) => item !== id) })}
              className="text-faint transition-colors hover:text-ink"
            >
              <X size={10} />
            </button>
          </span>
        )
      })}
      <select
        aria-label="태그 선택"
        value=""
        onChange={(event) => {
          const id = event.target.value
          if (id) onChange({ ...rule, value: [...selected, id] })
        }}
        className={SELECT}
      >
        <option value="">태그 선택...</option>
        {remaining.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function EnumValue({ rule, def, onChange }: { rule: FilterRule; def: FieldDef; onChange: (next: FilterRule) => void }) {
  const options = ENUM_OPTIONS[def.control] ?? []
  return (
    <select
      aria-label={`${def.label} 값`}
      value={typeof rule.value === 'string' ? rule.value : ''}
      onChange={(event) => onChange({ ...rule, value: event.target.value })}
      className={cn(SELECT, 'min-w-[104px]')}
    >
      <option value="">선택...</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {ENUM_LABELS[option] ?? option}
        </option>
      ))}
    </select>
  )
}

function RecordValue({
  rule,
  def,
  lookups,
  onChange,
}: {
  rule: FilterRule
  def: FieldDef
  lookups: Lookups
  onChange: (next: FilterRule) => void
}) {
  const options =
    def.control === 'library'
      ? lookups.libraries.map((library) => ({ id: library.id, label: library.name }))
      : lookups.folders.map((folder) => ({ id: folder.id, label: folder.relativePath || folder.name }))
  return (
    <select
      aria-label={`${def.label} 선택`}
      value={typeof rule.value === 'string' ? rule.value : ''}
      onChange={(event) => onChange({ ...rule, value: event.target.value })}
      className={cn(SELECT, 'max-w-[240px]')}
    >
      <option value="">선택...</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function RuleRow({
  rule,
  problem,
  lookups,
  onChange,
  onRemove,
}: {
  rule: FilterRule
  problem?: string
  lookups: Lookups
  onChange: (next: FilterRule) => void
  onRemove: () => void
}) {
  const entry = BUILDER_FIELDS.find((item) => item.field === rule.field)
  if (!entry) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted">이 편집기에서 다룰 수 없는 조건입니다.</span>
        <button
          type="button"
          aria-label="조건 제거"
          onClick={onRemove}
          className="ml-auto rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    )
  }
  const { def } = entry

  const value = typeof rule.value === 'string' ? rule.value : ''
  const controls =
    rule.operator === 'isNull' ? (
      <span className="text-[11.5px] text-faint">값이 없는 항목</span>
    ) : rule.operator === 'between' ? (
      <>
        <ScalarInput
          def={def}
          value={value}
          label={`${def.label} 시작`}
          onChange={(next) => onChange({ ...rule, value: next })}
        />
        <Minus size={11} className="text-faint" />
        <ScalarInput
          def={def}
          value={rule.upper ?? ''}
          label={`${def.label} 끝`}
          onChange={(next) => onChange({ ...rule, upper: next })}
        />
      </>
    ) : def.control === 'tag' ? (
      <TagValue rule={rule} tags={lookups.tags} onChange={onChange} />
    ) : def.control === 'library' || def.control === 'folder' ? (
      <RecordValue rule={rule} def={def} lookups={lookups} onChange={onChange} />
    ) : def.control === 'boolean' ? (
      <select
        aria-label={`${def.label} 값`}
        value={rule.value === true ? 'true' : 'false'}
        onChange={(event) => onChange({ ...rule, value: event.target.value === 'true' })}
        className={SELECT}
      >
        <option value="true">예</option>
        <option value="false">아니오</option>
      </select>
    ) : ENUM_OPTIONS[def.control] ? (
      <EnumValue rule={rule} def={def} onChange={onChange} />
    ) : (
      <ScalarInput
        def={def}
        value={value}
        label={`${def.label} 값`}
        onChange={(next) => onChange({ ...rule, value: next })}
      />
    )

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label="조건 항목"
          value={rule.field}
          onChange={(event) => onChange(changeRuleField(rule, event.target.value as FilterRule['field']))}
          className={cn(SELECT, 'w-[116px]')}
        >
          {BUILDER_FIELDS.map((item) => (
            <option key={item.field} value={item.field}>
              {item.def.label}
            </option>
          ))}
        </select>
        <select
          aria-label="조건 연산자"
          value={rule.operator}
          onChange={(event) => onChange(changeRuleOperator(rule, event.target.value as FilterOperator))}
          className={cn(SELECT, 'w-[104px]')}
        >
          {def.operators.map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </option>
          ))}
        </select>
        {controls}
        <button
          type="button"
          aria-label="조건 제거"
          onClick={onRemove}
          className="ml-auto rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
      {problem ? <p className="pl-1 text-[11px] text-danger">{problem}</p> : null}
    </div>
  )
}

function RuleGroup({
  title,
  hint,
  list,
  draft,
  lookups,
  problems,
  onChange,
}: {
  title: string
  hint: string
  list: 'rules' | 'none'
  draft: FilterDraft
  lookups: Lookups
  problems: RuleProblem[]
  onChange: (next: FilterDraft) => void
}) {
  const rules = draft[list]
  const setRules = (next: FilterRule[]) =>
    onChange(list === 'rules' ? { ...draft, rules: next } : { ...draft, none: next })

  return (
    <div className="rounded-xl border border-line bg-panel-2/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-[11px] text-faint">{hint}</p>
        </div>
        {list === 'rules' ? (
          <div
            role="group"
            aria-label="조건 조합"
            className="flex items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5"
          >
            {(
              [
                { id: 'all', label: '모두 만족' },
                { id: 'any', label: '하나라도 만족' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={draft.match === option.id}
                onClick={() => onChange({ ...draft, match: option.id })}
                className={cn(
                  'rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                  draft.match === option.id
                    ? 'bg-accent/15 text-accent'
                    : 'text-faint hover:text-ink',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-2.5 space-y-2">
        {rules.map((rule) => (
          <RuleRow
            key={rule.key}
            rule={rule}
            problem={problems.find((item) => item.key === rule.key)?.message}
            lookups={lookups}
            onChange={(next) => setRules(rules.map((item) => (item.key === rule.key ? next : item)))}
            onRemove={() => setRules(rules.filter((item) => item.key !== rule.key))}
          />
        ))}
        {rules.length === 0 ? (
          <p className="text-[11.5px] text-faint">조건이 없습니다.</p>
        ) : null}
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="mt-2"
        onClick={() => {
          const rule = newRule()
          if (rule) setRules([...rules, rule])
        }}
      >
        <Plus size={12} />
        {list === 'rules' ? '조건 추가' : '제외 조건 추가'}
      </Button>
    </div>
  )
}

export function FilterBuilder({
  draft,
  problems,
  onChange,
}: {
  draft: FilterDraft
  problems: RuleProblem[]
  onChange: (next: FilterDraft) => void
}) {
  const needsFolders = [...draft.rules, ...draft.none].some((rule) => rule.field === 'folder')
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.tags })
  const librariesQuery = useQuery({ queryKey: ['libraries'], queryFn: api.libraries })
  const foldersQuery = useQuery({
    queryKey: ['folders', 'all'],
    queryFn: () => api.folders(),
    enabled: needsFolders,
  })

  const lookups: Lookups = {
    tags: tagsQuery.data?.tags ?? [],
    libraries: librariesQuery.data ?? [],
    folders: foldersQuery.data ?? [],
  }

  return (
    <div className="space-y-2.5">
      <RuleGroup
        title="만족 조건"
        hint="이 조건을 만족하는 파일만 앨범에 담깁니다."
        list="rules"
        draft={draft}
        lookups={lookups}
        problems={problems}
        onChange={onChange}
      />
      <RuleGroup
        title="제외 조건"
        hint="하나라도 해당하면 목록에서 뺍니다."
        list="none"
        draft={draft}
        lookups={lookups}
        problems={problems}
        onChange={onChange}
      />
    </div>
  )
}
