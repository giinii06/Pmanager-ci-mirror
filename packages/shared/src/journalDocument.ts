export type JournalBlockKind =
  | 'paragraph' | 'heading1' | 'heading2' | 'heading3'
  | 'bulleted' | 'numbered' | 'todo' | 'quote' | 'callout'
  | 'code' | 'divider' | 'image' | 'table'

export interface JournalProperties {
  status: 'Not started' | 'In progress' | 'Done'
  tags: string[]
  dueDate: string | null
  icon: string
  favorite: boolean
}

export interface JournalBlock {
  id: string
  type: JournalBlockKind
  text: string
  checked?: boolean
  imageId?: string
  caption?: string
  cells?: string[][]
}

export interface JournalBlockDocument {
  version: 1
  properties: JournalProperties
  blocks: JournalBlock[]
}

export const JOURNAL_BLOCK_PREFIX = '@mediavault/journal-blocks/v1\\n'.replace('\\n', '\n')
export const JOURNAL_DEFAULT_PROPERTIES: JournalProperties = {
  status: 'Not started', tags: [], dueDate: null, icon: '📄', favorite: false,
}
const BLOCK_TYPES = new Set<JournalBlockKind>([
  'paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered',
  'todo', 'quote', 'callout', 'code', 'divider', 'image', 'table',
])

function properties(value: unknown): JournalProperties {
  if (!value || typeof value !== 'object') return { ...JOURNAL_DEFAULT_PROPERTIES, tags: [] }
  const raw = value as Record<string, unknown>
  return {
    status: raw.status === 'In progress' || raw.status === 'Done' ? raw.status : 'Not started',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 48)).slice(0, 24) : [],
    dueDate: typeof raw.dueDate === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(raw.dueDate) ? raw.dueDate : null,
    icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 8) : '📄',
    favorite: raw.favorite === true,
  }
}

export function isStructuredJournal(body: string): boolean {
  return body.startsWith(JOURNAL_BLOCK_PREFIX)
}

export function parseJournalDocument(body: string): JournalBlockDocument {
  if (isStructuredJournal(body)) {
    try {
      const parsed = JSON.parse(body.slice(JOURNAL_BLOCK_PREFIX.length)) as Record<string, unknown>
      if (parsed.version === 1 && Array.isArray(parsed.blocks)) {
        const blocks: JournalBlock[] = parsed.blocks.slice(0, 400).filter((b) => b && typeof b === 'object')
          .map((b: Record<string, unknown>, index) => ({
            id: typeof b.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(b.id) ? b.id : 'block_' + index,
            type: BLOCK_TYPES.has(b.type as JournalBlockKind) ? b.type as JournalBlockKind : 'paragraph',
            text: typeof b.text === 'string' ? b.text.slice(0, 8000) : '',
            checked: b.checked === true,
            imageId: typeof b.imageId === 'string' && /^[a-z0-9_-]{1,64}$/i.test(b.imageId) ? b.imageId : undefined,
            caption: typeof b.caption === 'string' ? b.caption.slice(0, 256) : undefined,
            cells: Array.isArray(b.cells)
              ? b.cells.slice(0, 30).map((row: unknown) => Array.isArray(row)
                ? row.slice(0, 12).map((cell: unknown) => String(cell ?? '').slice(0, 2000)) : [])
              : undefined,
          }))
        return { version: 1, properties: properties(parsed.properties), blocks }
      }
    } catch {
      // Retain malformed payload as plain text rather than discarding it.
    }
  }
  return { version: 1, properties: { ...JOURNAL_DEFAULT_PROPERTIES, tags: [] }, blocks: [
    { id: 'legacy', type: 'paragraph', text: body },
  ] }
}

export function journalDocumentProperties(body: string): JournalProperties {
  return parseJournalDocument(body).properties
}

export function serializeJournalDocument(document: JournalBlockDocument): string {
  return JOURNAL_BLOCK_PREFIX + JSON.stringify({
    version: 1,
    properties: properties(document.properties),
    blocks: document.blocks,
  })
}
