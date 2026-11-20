import { describe, expect, test } from 'bun:test'
import { encodeJournalMention, splitJournalBody } from './journalMentions'

describe('journal inline media mentions', () => {
  test('round-trips a video and an album between ordinary prose', () => {
    const movie = encodeJournalMention({ type: 'video', id: 'video1', label: '휴가 영상.mp4' })
    const album = encodeJournalMention({ type: 'album', id: 'folder1', label: '여행 사진' })
    expect(splitJournalBody('오늘 ' + movie + '\n그리고 ' + album + '!')).toEqual([
      { kind: 'text', value: '오늘 ' },
      { kind: 'mention', type: 'video', id: 'video1', label: '휴가 영상.mp4' },
      { kind: 'text', value: '\n그리고 ' },
      { kind: 'mention', type: 'album', id: 'folder1', label: '여행 사진' },
      { kind: 'text', value: '!' },
    ])
  })

  test('does not interpret untrusted HTML or malformed media references as rendered HTML', () => {
    const raw = '<img src=x onerror=alert(1)> @[wrong](video:hello!) @now'
    expect(splitJournalBody(raw)).toEqual([{ kind: 'text', value: raw }])
    expect(encodeJournalMention({ type: 'video', id: 'ok', label: 'line]\nbreak' }))
      .toBe('@[line  break](video:ok)')
  })

  test('empty and plain text remain plain', () => {
    expect(splitJournalBody('')).toEqual([{ kind: 'text', value: '' }])
    expect(splitJournalBody('Hello world')).toEqual([{ kind: 'text', value: 'Hello world' }])
  })
})
