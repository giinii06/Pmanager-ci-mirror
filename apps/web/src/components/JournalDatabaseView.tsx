import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Columns3, Grid2X2, ListFilter, Search, Table2 } from 'lucide-react'
import { JOURNAL_DEFAULT_PROPERTIES, type JournalEntrySummaryDTO, type JournalProperties } from '@mediavault/shared'
import { JournalTable } from './JournalTable'

type View = 'table' | 'board' | 'calendar' | 'gallery'
type Sort = 'recent' | 'oldest' | 'title' | 'due'
const STATUS: JournalProperties['status'][] = ['Not started', 'In progress', 'Done']
const STATUS_LABEL: Record<JournalProperties['status'], string> = {
  'Not started': '미시작', 'In progress': '진행 중', 'Done': '완료',
}

interface Props {
  entries: JournalEntrySummaryDTO[]
  creating: boolean
  onCreate: () => void
}

function propsOf(entry: JournalEntrySummaryDTO): JournalProperties {
  return entry.properties ?? JOURNAL_DEFAULT_PROPERTIES
}

function href(entry: JournalEntrySummaryDTO): string {
  return '/journal/' + encodeURIComponent(entry.id)
}

function title(entry: JournalEntrySummaryDTO): string {
  return (entry.title.trim() || '제목 없음')
}

function PageCard({ entry }: { entry: JournalEntrySummaryDTO }) {
  const p = propsOf(entry)
  return (
    <Link to={href(entry)} className="block rounded-xl border border-line bg-panel p-4 shadow-[var(--ui-elevation)] transition-colors hover:bg-panel-2">
      <div className="truncate text-[14px] font-semibold text-ink">{p.icon || '📄'} {title(entry)}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span className="rounded bg-accent/15 px-2 py-0.5 text-accent">{STATUS_LABEL[p.status]}</span>
        {p.dueDate ? <span>{p.dueDate}</span> : null}
        {p.favorite ? <span>★</span> : null}
        {p.tags.map((tag) => <span key={tag} className="rounded bg-raised px-1.5 py-0.5">{tag}</span>)}
      </div>
    </Link>
  )
}

function CalendarView({ entries }: { entries: JournalEntrySummaryDTO[] }) {
  const [offset, setOffset] = useState(0)
  const today = new Date()
  const month = new Date(today.getFullYear(), today.getMonth() + offset, 1)
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const first = new Date(year, monthIndex, 1).getDay()
  const days = new Date(year, monthIndex + 1, 0).getDate()
  const cells = Array.from({ length: first + days }, (_, i) => i - first + 1)
  const dateKey = (day: number) => year + '-' + String(monthIndex + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0')
  return (
    <section aria-label="일지 캘린더 보기" className="mt-4 rounded-panel border border-line bg-panel p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[17px] font-semibold text-ink">{year}년 {monthIndex + 1}월</h3>
        <div className="flex gap-1">
          <button type="button" onClick={() => setOffset((v) => v - 1)} className="rounded-lg px-3 py-1 text-muted hover:bg-raised" aria-label="이전 달">‹</button>
          <button type="button" onClick={() => setOffset(0)} className="rounded-lg px-3 py-1 text-muted hover:bg-raised">오늘</button>
          <button type="button" onClick={() => setOffset((v) => v + 1)} className="rounded-lg px-3 py-1 text-muted hover:bg-raised" aria-label="다음 달">›</button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[12px] text-muted">
        {['일', '월', '화', '수', '목', '금', '토'].map((day) => <div key={day} className="border-b border-line py-2">{day}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const matching = day <= 0 ? [] : entries.filter((entry) =>
            (propsOf(entry).dueDate ?? entry.createdAt.slice(0, 10)) === dateKey(day))
          return (
            <div key={i} className="min-h-24 min-w-0 border-b border-r border-line p-1.5">
              {day > 0 ? <span className="text-[12px] text-muted">{day}</span> : null}
              {matching.slice(0, 3).map((entry) => (
                <Link key={entry.id} to={href(entry)} title={title(entry)}
                  className="mt-1 block truncate rounded bg-accent/10 px-1 py-0.5 text-[11px] text-accent hover:bg-accent/20">
                  {propsOf(entry).icon} {title(entry)}
                </Link>
              ))}
              {matching.length > 3 ? <span className="text-[10px] text-faint">+{matching.length - 3}개</span> : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function JournalDatabaseView({ entries, creating, onCreate }: Props) {
  const [view, setView] = useState<View>('table')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('ko-KR')
    const list = entries.filter((entry) => {
      const properties = propsOf(entry)
      return (!q || title(entry).toLocaleLowerCase('ko-KR').includes(q) || properties.tags.some((tag) => tag.toLocaleLowerCase('ko-KR').includes(q))) &&
        (status === 'all' || properties.status === status) &&
        (!favoritesOnly || properties.favorite)
    })
    return list.sort((a, b) => {
      if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt)
      if (sort === 'title') return title(a).localeCompare(title(b), 'ko')
      if (sort === 'due') return (propsOf(a).dueDate ?? '9999').localeCompare(propsOf(b).dueDate ?? '9999')
      return b.createdAt.localeCompare(a.createdAt)
    })
  }, [entries, search, status, sort, favoritesOnly])

  return (
    <div className="mt-9">
      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3" role="tablist" aria-label="데이터베이스 보기">
        {([
          ['table', Table2, '표'],
          ['board', Columns3, '보드'],
          ['calendar', CalendarDays, '캘린더'],
          ['gallery', Grid2X2, '갤러리'],
        ] as const).map(([value, Icon, label]) => (
          <button key={value} type="button" role="tab" aria-selected={view === value} onClick={() => setView(value)}
            className={'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] ' +
              (view === value ? 'bg-accent/15 font-semibold text-accent' : 'text-muted hover:bg-raised')}>
            <Icon size={14} /> {label}
          </button>
        ))}
        <span className="ml-auto text-[12px] text-faint">{filtered.length}개 페이지</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
          <Search size={14} className="text-muted" />
          <input aria-label="일지 검색" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="페이지 또는 태그 검색" className="min-w-36 bg-transparent text-ink outline-none placeholder:text-faint" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-muted">
          <ListFilter size={14} />
          <select aria-label="상태 필터" value={status} onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-line bg-panel px-2 py-2 text-ink">
            <option value="all">전체 상태</option>
            {STATUS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <select aria-label="일지 정렬" value={sort} onChange={(event) => setSort(event.target.value as Sort)}
          className="rounded-lg border border-line bg-panel px-2 py-2 text-ink">
          <option value="recent">최신 생성순</option>
          <option value="oldest">오래된순</option>
          <option value="title">이름순</option>
          <option value="due">마감일순</option>
        </select>
        <button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}
          className={'rounded-lg border border-line px-3 py-2 ' + (favoritesOnly ? 'bg-accent/15 text-accent' : 'bg-panel text-muted hover:text-ink')}>
          ★ 즐겨찾기
        </button>
      </div>

      {view === 'table' ? <div className="[&>section]:mt-4"><JournalTable entries={filtered} creating={creating} onCreate={onCreate} /></div> :
        view === 'calendar' ? <CalendarView entries={filtered} /> :
        view === 'gallery' ? (
          <section aria-label="일지 갤러리 보기" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((entry) => <PageCard key={entry.id} entry={entry} />)}
          </section>
        ) : (
          <section aria-label="일지 보드 보기" className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            {STATUS.map((s) => (
              <div key={s} className="min-w-0 rounded-xl bg-panel-2 p-3">
                <h3 className="mb-3 text-[13px] font-semibold text-ink">{STATUS_LABEL[s]} · {filtered.filter((e) => propsOf(e).status === s).length}</h3>
                <div className="space-y-2">{filtered.filter((e) => propsOf(e).status === s)
                  .map((entry) => <PageCard key={entry.id} entry={entry} />)}</div>
              </div>
            ))}
          </section>
        )}
    </div>
  )
}
