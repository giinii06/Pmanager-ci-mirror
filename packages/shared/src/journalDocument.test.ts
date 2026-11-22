import { describe, expect, test } from 'bun:test'
import { JOURNAL_DEFAULT_PROPERTIES, isStructuredJournal, journalDocumentProperties, parseJournalDocument, serializeJournalDocument } from './journalDocument'

describe('journal block document', () => {
  test('preserves a legacy body without implicit migration', () => {
    const legacy = 'First line\\n@[movie](video:movie-1)'
    const doc = parseJournalDocument(legacy)
    expect(doc.blocks[0]?.text).toBe(legacy)
    expect(isStructuredJournal(legacy)).toBe(false)
  })
  test('round-trips properties and blocks safely', () => {
    const body = serializeJournalDocument({
      version: 1, properties: { ...JOURNAL_DEFAULT_PROPERTIES, status: 'Done', tags: ['Travel'] },
      blocks: [{ id: 'b1', type: 'image', imageId: 'abc123', text: '', caption: 'Beach' }],
    })
    expect(isStructuredJournal(body)).toBe(true)
    expect(parseJournalDocument(body).blocks[0]?.imageId).toBe('abc123')
    expect(journalDocumentProperties(body).status).toBe('Done')
    expect(journalDocumentProperties(body).tags).toEqual(['Travel'])
  })
  test('does not accept arbitrary executable image URL properties', () => {
    const body = serializeJournalDocument({ version: 1, properties: JOURNAL_DEFAULT_PROPERTIES,
      blocks: [{ id: 'one', type: 'image', imageId: 'javascript:alert(1)', text: '' }],
    })
    expect(parseJournalDocument(body).blocks[0]?.imageId).toBeUndefined()
  })
})
