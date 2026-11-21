import { ArrowUpRight, CalendarClock, CalendarDays, FileText, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { JournalEntrySummaryDTO } from '@mediavault/shared'

interface JournalTableProps {
  entries: JournalEntrySummaryDTO[]
  creating: boolean
  onCreate: () => void
}

export function journalTableDate(timestamp: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp))
}

/** A journal entry is a page; keep row links native so keyboard and new-tab navigation work. */
export function JournalTable({ entries, creating, onCreate }: JournalTableProps) {
  return (
    <section aria-label="일지 페이지 목록" className="mt-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[16px] font-semibold text-ink">모든 페이지</h2>
          <span className="text-[13px] text-faint">{entries.length}개{entries.length > 0 ? ' 표시 중' : ''}</span>
        </div>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line bg-panel px-3.5 text-[13px] font-semibold text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus size={15} aria-hidden="true" /> 새 페이지
        </button>
      </div>
      <div className="overflow-hidden rounded-panel border border-line bg-panel shadow-[var(--ui-elevation)]">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-panel-2/65 text-[12.5px] font-normal text-muted">
              <th scope="col" className="w-[60%] border-r border-line px-4 py-3.5 font-medium md:w-[46%]">
                <span className="inline-flex items-center gap-2"><FileText size={14} aria-hidden="true" /> 이름</span>
              </th>
              <th scope="col" className="hidden border-r border-line px-4 py-3.5 font-medium md:table-cell md:w-[25%]">
                <span className="inline-flex items-center gap-2"><CalendarClock size={14} aria-hidden="true" /> 수정 일시</span>
              </th>
              <th scope="col" className="w-[40%] px-4 py-3.5 font-medium md:w-[29%]">
                <span className="inline-flex items-center gap-2"><CalendarDays size={14} aria-hidden="true" /> 생성 일시</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const href = '/journal/' + encodeURIComponent(entry.id)
              const title = entry.title.trim() || '제목 없음'
              return (
                <tr key={entry.id} className="group border-b border-line/75 transition-colors last:border-b-0 hover:bg-panel-2 focus-within:bg-panel-2">
                  <td className="border-r border-line px-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        to={href}
                        className="flex min-w-0 flex-1 items-center gap-3 py-4.5 text-[14px] font-semibold text-ink hover:underline sm:text-[16px]"
                        title={title}
                      >
                        <FileText size={18} className="shrink-0 text-faint" aria-hidden="true" />
                        <span className="truncate">{title}</span>
                      </Link>
                      <Link
                        to={href}
                        aria-label={title + ' 열기'}
                        className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-panel-2 px-2.5 py-1.5 text-[12px] font-semibold text-muted transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                      >
                        열기 <ArrowUpRight size={13} aria-hidden="true" />
                      </Link>
                    </div>
                  </td>
                  <td className="hidden border-r border-line px-4 py-4 text-[13px] text-muted md:table-cell">
                    <time dateTime={entry.updatedAt}>{journalTableDate(entry.updatedAt)}</time>
                  </td>
                  <td className="px-4 py-4 text-[12px] text-muted sm:text-[13px]">
                    <time dateTime={entry.createdAt} className="block truncate" title={journalTableDate(entry.createdAt)}>
                      {journalTableDate(entry.createdAt)}
                    </time>
                  </td>
                </tr>
              )
            })}
            {entries.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-14 text-center text-[14px] text-muted">
                  아직 작성한 일지가 없습니다. 새 페이지를 추가해 보세요.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <button
                  type="button"
                  onClick={onCreate}
                  disabled={creating}
                  className="flex min-h-12 w-full items-center gap-2.5 px-4 text-left text-[13px] font-medium text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Plus size={16} aria-hidden="true" /> 새 페이지
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
