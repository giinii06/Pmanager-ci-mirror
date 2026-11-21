import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { JournalEntrySummaryDTO } from '@mediavault/shared'
import { JournalTable, journalTableDate } from './JournalTable'

const entries: JournalEntrySummaryDTO[] = [
  {
    id: 'abc123',
    title: '드디어 콘서타 복용을 시작했다.',
    createdAt: '2026-11-14T05:14:00+09:00',
    updatedAt: '2026-11-15T07:30:00+09:00',
  },
  {
    id: 'def456',
    title: '',
    createdAt: '2026-11-13T16:29:00+09:00',
    updatedAt: '2026-11-13T16:29:00+09:00',
  },
]

function render(items: JournalEntrySummaryDTO[], creating = false) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <JournalTable entries={items} creating={creating} onCreate={() => {}} />
    </MemoryRouter>,
  )
}

describe('notion-style journal list', () => {
  test('renders existing titles, untitled fallback and direct links to the existing editor', () => {
    const html = render(entries)
    expect(html).toContain('드디어 콘서타 복용을 시작했다.')
    expect(html).toContain('제목 없음')
    expect(html).toContain('href="/journal/abc123"')
    expect(html).toContain('href="/journal/def456"')
    expect(html).toContain('aria-label="드디어 콘서타 복용을 시작했다. 열기"')
    expect(html).toContain('group-hover:opacity-100')
    expect(html).toContain('group-focus-within:opacity-100')
  })

  test('shows each server-owned created/updated timestamp and a Korean locale date', () => {
    const html = render(entries)
    expect(html).toContain('dateTime="2026-11-14T05:14:00+09:00"')
    expect(html).toContain('dateTime="2026-11-15T07:30:00+09:00"')
    expect(journalTableDate(entries[0]!.createdAt)).toContain('2026년')
    expect(html).toContain('수정 일시')
    expect(html).toContain('생성 일시')
  })

  test('offers page creation even with an empty list and disables both actions while creating', () => {
    const empty = render([])
    expect(empty).toContain('아직 작성한 일지가 없습니다.')
    expect((empty.match(/새 페이지/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const busy = render([], true)
    expect((busy.match(/disabled=""/g) ?? []).length).toBe(2)
  })
})
