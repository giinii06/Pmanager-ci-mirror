import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { JournalEntrySummaryDTO } from '@mediavault/shared'
import { JournalDatabaseView } from './JournalDatabaseView'

const entry: JournalEntrySummaryDTO = {
  id: 'journal-a',
  title: '도서 리뷰',
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T01:00:00.000Z',
  coverImageId: 'image-a',
  properties: {
    status: 'In progress',
    tags: ['독서', '리뷰'],
    dueDate: '2026-11-25',
    icon: '📚',
    favorite: true,
  },
}

describe('journal database default view', () => {
  test('renders Notion-like table/board/calendar/gallery tabs and properties', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <JournalDatabaseView entries={[entry]} creating={false} onCreate={() => {}} />
      </MemoryRouter>,
    )
    expect(html).toContain('도서 리뷰')
    expect(html).toContain('href="/journal/journal-a"')
    expect(html).toContain('보드')
    expect(html).toContain('캘린더')
    expect(html).toContain('갤러리')
    expect(html).toContain('진행 중')
    expect(html).toContain('2026-11-25')
    expect(html).toContain('독서')
    expect(html).toContain('리뷰')
  })
})
