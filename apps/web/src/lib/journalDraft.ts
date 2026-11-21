import type { JournalEntryDTO } from '@mediavault/shared'

export type JournalSaveStatus = 'saved' | 'editing' | 'saving' | 'error' | 'conflict'
export type JournalText = Pick<JournalEntryDTO, 'title' | 'body'>

export interface JournalDraft extends JournalText {
  baseUpdatedAt: string
}

export interface JournalDraftStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function journalDraftKey(userId: string, entryId: string): string {
  return 'mediavault:journal:draft:' + encodeURIComponent(userId) + ':' + entryId
}

export function readJournalDraft(store: JournalDraftStore | null, key: string): JournalDraft | null {
  if (!store) return null
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const draft: unknown = JSON.parse(raw)
    if (!draft || typeof draft !== 'object') return null
    const data = draft as Record<string, unknown>
    if (
      typeof data.title !== 'string' || data.title.length > 160 ||
      typeof data.body !== 'string' || data.body.length > 100_000 ||
      typeof data.baseUpdatedAt !== 'string'
    ) return null
    return { title: data.title, body: data.body, baseUpdatedAt: data.baseUpdatedAt }
  } catch {
    return null
  }
}

function saveDraft(store: JournalDraftStore | null, key: string, value: JournalDraft): boolean {
  if (!store) return false
  try {
    store.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function dropDraft(store: JournalDraftStore | null, key: string, expected?: JournalText): void {
  if (!store) return
  try {
    const draft = readJournalDraft(store, key)
    if (!expected || (draft && sameText(draft, expected))) store.removeItem(key)
  } catch {
    // Disabling browser storage must never interrupt a successful server save.
  }
}

function sameText(a: JournalText, b: JournalText): boolean {
  return a.title === b.title && a.body === b.body
}

function isVersionConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'status' in error && error.status === 409
}

export interface JournalSaveOptions {
  entry: JournalEntryDTO
  store: JournalDraftStore | null
  draftKey: string
  persist: (value: JournalText & { expectedUpdatedAt: string }) => Promise<JournalEntryDTO>
  onStatus: (status: JournalSaveStatus) => void
  onSaved: (entry: JournalEntryDTO) => void
  onError: (error: unknown, conflicted: boolean) => void
}

/**
 * Serialises writes and preserves every unsaved edit in origin-scoped browser
 * storage. A server revision mismatch never silently overwrites another tab.
 */
export class JournalSaveCoordinator {
  readonly initial: JournalText
  readonly initialStatus: JournalSaveStatus
  private latest: JournalText
  private persisted: JournalText
  private revision: string
  private conflicted = false
  private deleting = false
  private pending: Promise<void> = Promise.resolve()
  failedAttempts = 0

  constructor(private readonly options: JournalSaveOptions) {
    const { entry, store, draftKey } = options
    this.persisted = { title: entry.title, body: entry.body }
    this.revision = entry.updatedAt
    const draft = readJournalDraft(store, draftKey)
    this.latest = draft ? { title: draft.title, body: draft.body } : { ...this.persisted }
    this.conflicted = Boolean(
      draft && draft.baseUpdatedAt !== entry.updatedAt && !sameText(draft, this.persisted),
    )
    this.initialStatus = this.conflicted
      ? 'conflict'
      : sameText(this.latest, this.persisted) ? 'saved' : 'editing'
    this.initial = { ...this.latest }
    if (this.initialStatus === 'saved') dropDraft(store, draftKey, this.latest)
  }

  get current(): JournalText {
    return { ...this.latest }
  }

  get hasUnsavedChanges(): boolean {
    return !sameText(this.latest, this.persisted)
  }

  get isConflicted(): boolean {
    return this.conflicted
  }

  private setStatus(status: JournalSaveStatus): void {
    this.options.onStatus(status)
  }

  /** Persist the draft synchronously before React/route state can unmount. */
  edit(next: JournalText): boolean {
    if (this.deleting) return false
    this.latest = { ...next }
    this.failedAttempts = 0
    if (!this.hasUnsavedChanges) {
      dropDraft(this.options.store, this.options.draftKey, next)
    } else {
      const stored = saveDraft(this.options.store, this.options.draftKey, {
        ...next,
        baseUpdatedAt: this.revision,
      })
      if (!stored) {
        this.setStatus('error')
        return false
      }
    }
    this.setStatus(this.conflicted ? 'conflict' : this.hasUnsavedChanges ? 'editing' : 'saved')
    return true
  }

  save(): Promise<boolean> {
    const operation = this.pending.then(async () => {
      if (this.deleting) return true
      if (this.conflicted) return false
      const snapshot = { ...this.latest }
      if (sameText(snapshot, this.persisted)) {
        this.setStatus('saved')
        return true
      }
      this.setStatus('saving')
      try {
        const saved = await this.options.persist({
          ...snapshot,
          expectedUpdatedAt: this.revision,
        })
        this.persisted = { title: saved.title, body: saved.body }
        this.revision = saved.updatedAt
        this.failedAttempts = 0

        if (sameText(this.latest, snapshot)) {
          dropDraft(this.options.store, this.options.draftKey, snapshot)
          this.setStatus('saved')
        } else {
          saveDraft(this.options.store, this.options.draftKey, {
            ...this.latest,
            baseUpdatedAt: this.revision,
          })
          this.setStatus('editing')
        }
        this.options.onSaved(saved)
        return true
      } catch (error) {
        this.conflicted = isVersionConflict(error)
        this.failedAttempts += 1
        this.setStatus(this.conflicted ? 'conflict' : 'error')
        this.options.onError(error, this.conflicted)
        return false
      }
    })
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  /**
   * Explicitly resolve the conflict by abandoning this browser's local draft.
   * The caller must update the editor DOM to the returned content as well.
   */
  resetToServer(entry: JournalEntryDTO): void {
    this.latest = { title: entry.title, body: entry.body }
    this.persisted = { ...this.latest }
    this.revision = entry.updatedAt
    this.conflicted = false
    this.failedAttempts = 0
    dropDraft(this.options.store, this.options.draftKey)
    this.setStatus('saved')
  }

  /** Intentional user-directed overwrite; still uses server CAS to protect races. */
  allowOverwrite(revision: string): void {
    this.revision = revision
    this.conflicted = false
    this.setStatus('editing')
    saveDraft(this.options.store, this.options.draftKey, {
      ...this.latest,
      baseUpdatedAt: revision,
    })
  }

  async beginDelete(): Promise<void> {
    this.deleting = true
    await this.pending
  }

  cancelDelete(): void {
    this.deleting = false
  }

  /** Called only after server confirms deletion, never when the request fails. */
  forget(): void {
    dropDraft(this.options.store, this.options.draftKey)
  }
}
