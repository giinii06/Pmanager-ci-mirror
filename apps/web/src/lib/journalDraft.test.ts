import { describe, expect, test } from 'bun:test'
import type { JournalEntryDTO } from '@mediavault/shared'
import { JournalSaveCoordinator, journalDraftKey, readJournalDraft, type JournalDraftStore, type JournalSaveStatus } from './journalDraft'

function store(): JournalDraftStore {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

const entry: JournalEntryDTO = {
  id: 'page001',
  title: 'Old',
  body: 'Original',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
}

describe('journal durable editing', () => {
  test('keeps unsaved edits after navigating away and reloads them from scoped browser storage', () => {
    const storage = store()
    const key = journalDraftKey('owner', entry.id)
    const callbacks = {
      entry, store: storage, draftKey: key, persist: async () => entry,
      onStatus: () => {}, onSaved: () => {}, onError: () => {},
    }
    const first = new JournalSaveCoordinator(callbacks)
    expect(first.edit({ title: 'Recovered', body: 'Unsaved text' })).toBe(true)
    expect(readJournalDraft(storage, key)?.title).toBe('Recovered')
    const reopened = new JournalSaveCoordinator(callbacks)
    expect(reopened.initial).toEqual({ title: 'Recovered', body: 'Unsaved text' })
    expect(reopened.initialStatus).toBe('editing')
    expect(readJournalDraft(storage, journalDraftKey('other', entry.id))).toBeNull()
  })

  test('a successful queued save updates the revision and clears its matching draft', async () => {
    const storage = store()
    const key = journalDraftKey('owner', entry.id)
    let revision = 1
    let firstStarted!: () => void
    let releaseFirst!: () => void
    const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve })
    const firstAllowed = new Promise<void>((resolve) => { releaseFirst = resolve })
    const payloads: string[] = []
    const saved: JournalEntryDTO[] = []
    const model = new JournalSaveCoordinator({
      entry, store: storage, draftKey: key,
      persist: async (value) => {
        payloads.push(value.expectedUpdatedAt)
        if (revision === 1) {
          firstStarted()
          await firstAllowed
        }
        const updated = { ...entry, ...value, updatedAt: 'revision-' + revision++ }
        return updated
      },
      onStatus: () => {}, onSaved: (value) => saved.push(value), onError: () => {},
    })
    model.edit({ title: 'Newest', body: 'First version' })
    const one = model.save()
    await firstRunning
    model.edit({ title: 'Newest', body: 'Latest version' })
    const two = model.save()
    releaseFirst()
    expect(await one).toBe(true)
    expect(await two).toBe(true)
    expect(payloads).toEqual([entry.updatedAt, 'revision-1'])
    expect(saved.at(-1)?.body).toBe('Latest version')
    expect(readJournalDraft(storage, key)).toBeNull()
    expect(model.hasUnsavedChanges).toBe(false)
  })

  test('a transport failure keeps a recoverable draft; manual retry succeeds', async () => {
    const storage = store()
    const key = journalDraftKey('owner', entry.id)
    let fail = true
    let status: JournalSaveStatus = 'saved'
    const model = new JournalSaveCoordinator({
      entry, store: storage, draftKey: key,
      persist: async (value) => {
        if (fail) throw new Error('offline')
        return { ...entry, ...value, updatedAt: 'new-revision' }
      },
      onStatus: (next) => { status = next },
      onSaved: () => {},
      onError: () => {},
    })
    model.edit({ title: 'Offline change', body: 'Keep me' })
    expect(await model.save()).toBe(false)
    expect(status as JournalSaveStatus).toBe('error')
    expect(readJournalDraft(storage, key)?.body).toBe('Keep me')
    fail = false
    expect(await model.save()).toBe(true)
    expect(status as JournalSaveStatus).toBe('saved')
    expect(readJournalDraft(storage, key)).toBeNull()
  })

  test('two-tab conflict never overwrites remote text until explicit recovery', async () => {
    const storage = store()
    const key = journalDraftKey('owner', entry.id)
    let sent = 0
    let status: JournalSaveStatus = 'saved'
    const model = new JournalSaveCoordinator({
      entry, store: storage, draftKey: key,
      persist: async () => {
        sent++
        throw Object.assign(new Error('conflict'), { status: 409 })
      },
      onStatus: (next) => { status = next }, onSaved: () => {}, onError: () => {},
    })
    model.edit({ title: 'My draft', body: 'Important' })
    expect(await model.save()).toBe(false)
    expect(model.isConflicted).toBe(true)
    expect(status as JournalSaveStatus).toBe('conflict')
    expect(await model.save()).toBe(false)
    expect(sent).toBe(1)
    const afterReload = new JournalSaveCoordinator({
      entry: { ...entry, updatedAt: 'remote-revision' }, store: storage, draftKey: key,
      persist: async () => entry, onStatus: () => {}, onSaved: () => {}, onError: () => {},
    })
    expect(afterReload.initialStatus).toBe('conflict')
    expect(afterReload.initial.body).toBe('Important')
    afterReload.resetToServer({ ...entry, body: 'Remote', updatedAt: 'remote-revision' })
    expect(afterReload.current.body).toBe('Remote')
    expect(readJournalDraft(storage, key)).toBeNull()
  })

  test('failed deletion never discards a recoverable draft', async () => {
    const storage = store()
    const key = journalDraftKey('owner', entry.id)
    const model = new JournalSaveCoordinator({
      entry, store: storage, draftKey: key,
      persist: async () => entry, onStatus: () => {}, onSaved: () => {}, onError: () => {},
    })
    model.edit({ title: 'Draft', body: 'Keep' })
    await model.beginDelete()
    model.cancelDelete()
    expect(readJournalDraft(storage, key)?.body).toBe('Keep')
    model.forget()
    expect(readJournalDraft(storage, key)).toBeNull()
  })
})
