import type { JournalMentionDTO } from '@mediavault/shared'

export type JournalPart =
  | { kind: 'text'; value: string }
  | { kind: 'mention'; type: 'video' | 'album'; id: string; label: string }

const MENTION = /@\[([^\]\n]{1,160})\]\((video|album):([a-z0-9_-]{1,64})\)/g

/** Stored as text, not trusted HTML; the view constructs safe DOM nodes. */
export function splitJournalBody(body: string): JournalPart[] {
  const pieces: JournalPart[] = []
  MENTION.lastIndex = 0
  let offset = 0
  for (const match of body.matchAll(MENTION)) {
    const index = match.index
    if (index > offset) pieces.push({ kind: 'text', value: body.slice(offset, index) })
    pieces.push({
      kind: 'mention',
      label: match[1]!,
      type: match[2] as 'video' | 'album',
      id: match[3]!,
    })
    offset = index + match[0].length
  }
  if (offset < body.length || pieces.length === 0) pieces.push({ kind: 'text', value: body.slice(offset) })
  return pieces
}

export function encodeJournalMention(mention: Pick<JournalMentionDTO, 'type' | 'id' | 'label'>): string {
  // Newlines and closing brackets would break this tiny Markdown-like token.
  const label = mention.label.replace(/[\]\r\n]/g, ' ').slice(0, 160)
  return '@[' + label + '](' + mention.type + ':' + mention.id + ')'
}
