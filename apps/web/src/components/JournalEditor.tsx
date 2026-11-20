import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Film, Images, Loader2 } from 'lucide-react'
import type { JournalMentionDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { encodeJournalMention, splitJournalBody } from '../lib/journalMentions'

interface JournalEditorProps {
  entryId: string
  initialBody: string
  onChange: (body: string) => void
  onBlurSave: () => void
  onOpenMention: (mention: JournalMentionDTO) => void
}

function makeMentionNode(mention: Pick<JournalMentionDTO, 'type' | 'id' | 'label'>): HTMLSpanElement {
  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.dataset.journalMention = 'true'
  span.dataset.mentionType = mention.type
  span.dataset.mentionId = mention.id
  span.dataset.mentionLabel = mention.label
  span.textContent = '@' + mention.label
  span.title = (mention.type === 'video' ? '동영상' : '사진 앨범') + ' 열기'
  return span
}

function plainBody(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as HTMLElement
    if (element.dataset.journalMention === 'true') {
      const type = element.dataset.mentionType
      const id = element.dataset.mentionId
      if ((type === 'video' || type === 'album') && id) {
        return encodeJournalMention({
          type,
          id,
          label: element.dataset.mentionLabel ?? element.textContent ?? '',
        })
      }
    }
    if (element.tagName === 'BR') return '\n'
    const inner = Array.from(node.childNodes).map(walk).join('')
    return (element.tagName === 'DIV' || element.tagName === 'P') && element !== root
      ? inner + '\n'
      : inner
  }
  return Array.from(root.childNodes).map(walk).join('')
}

export function JournalEditor({
  entryId,
  initialBody,
  onChange,
  onBlurSave,
  onOpenMention,
}: JournalEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Range | null>(null)
  const [mentionTerm, setMentionTerm] = useState<string | null>(null)
  const [choice, setChoice] = useState(0)
  const [popup, setPopup] = useState({ top: 0, left: 0 })
  const suggestions = useQuery({
    queryKey: ['journal', 'mentions', mentionTerm],
    queryFn: () => api.journalMentions(mentionTerm ?? ''),
    enabled: mentionTerm !== null,
    staleTime: 15_000,
  })
  const items = suggestions.data?.items ?? []

  // Never replace content while typing: only rebuild the DOM on page navigation.
  useEffect(() => {
    const root = editorRef.current
    if (!root) return
    const fragment = document.createDocumentFragment()
    for (const part of splitJournalBody(initialBody)) {
      if (part.kind === 'text' && part.value === '') continue
      fragment.append(
        part.kind === 'text' ? document.createTextNode(part.value) : makeMentionNode(part),
      )
    }
    root.replaceChildren(fragment)
    triggerRef.current = null
    setMentionTerm(null)
    setChoice(0)
    // This component is keyed by page id. Subsequent autosaves must preserve the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId])

  const report = useCallback(() => {
    const root = editorRef.current
    if (!root) return
    onChange(plainBody(root))

    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const offset = selection?.anchorOffset ?? 0
    if (!anchor || anchor.nodeType !== Node.TEXT_NODE || !root.contains(anchor)) {
      setMentionTerm(null)
      triggerRef.current = null
      return
    }
    const prior = (anchor.textContent ?? '').slice(0, offset)
    const match = /@([^\s@]{0,40})$/u.exec(prior)
    const start = match ? offset - match[0].length : -1
    if (!match || (start > 0 && !/\s/.test(prior[start - 1]!))) {
      setMentionTerm(null)
      triggerRef.current = null
      return
    }
    const range = document.createRange()
    range.setStart(anchor, start)
    range.setEnd(anchor, offset)
    triggerRef.current = range
    const rect = range.getBoundingClientRect()
    const parent = containerRef.current?.getBoundingClientRect()
    if (parent) {
      setPopup({
        left: Math.max(0, Math.min(rect.left - parent.left, parent.width - 300)),
        top: rect.bottom - parent.top + 8,
      })
    }
    setChoice(0)
    setMentionTerm(match[1]!)
  }, [onChange])

  const insertPlainText = (value: string) => {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const text = document.createTextNode(value)
    range.insertNode(text)
    range.setStartAfter(text)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    report()
  }

  const selectMention = (item: JournalMentionDTO) => {
    const root = editorRef.current
    const range = triggerRef.current
    if (!root || !range || !root.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const mention = makeMentionNode(item)
    range.insertNode(mention)
    const spacer = document.createTextNode(' ')
    mention.after(spacer)
    range.setStartAfter(spacer)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    root.focus()
    triggerRef.current = null
    setMentionTerm(null)
    setChoice(0)
    onChange(plainBody(root))
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mentionTerm !== null && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setChoice((value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        selectMention(items[Math.min(choice, items.length - 1)]!)
        return
      }
    }
    if (event.key === 'Escape' && mentionTerm !== null) {
      event.preventDefault()
      setMentionTerm(null)
      triggerRef.current = null
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      insertPlainText('\n')
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const root = editorRef.current
    if (!root) return
    const selectedLength = window.getSelection()?.toString().length ?? 0
    const remaining = Math.max(0, 100_000 - plainBody(root).length + selectedLength)
    insertPlainText(event.clipboardData.getData('text/plain').slice(0, remaining))
  }

  return (
    <div ref={containerRef} className="relative min-h-[40vh]">
      <div
        ref={editorRef}
        role="textbox"
        aria-label="일지 본문"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-placeholder="오늘 있었던 일을 자유롭게 기록해 보세요. @를 입력해 동영상이나 사진 앨범을 연결할 수 있어요."
        className="journal-editor min-h-[40vh] w-full whitespace-pre-wrap break-words text-[16px] leading-[1.95] text-ink outline-none focus:outline-none"
        onInput={report}
        onBeforeInput={(event) => {
          const root = editorRef.current
          if (!root) return
          const input = event.nativeEvent as InputEvent
          if (input.inputType?.startsWith('insert') && plainBody(root).length >= 100_000) {
            event.preventDefault()
          }
        }}
        onKeyDown={onKey}
        onPaste={onPaste}
        onBlur={onBlurSave}
        onClick={(event) => {
          const mention = (event.target as HTMLElement).closest<HTMLElement>('[data-journal-mention]')
          if (!mention) return
          const type = mention.dataset.mentionType
          const id = mention.dataset.mentionId
          if ((type === 'video' || type === 'album') && id) {
            onOpenMention({ type, id, label: mention.dataset.mentionLabel ?? '', libraryName: '' })
          }
        }}
      />

      {mentionTerm !== null ? (
        <div
          className="absolute z-20 w-[min(360px,90vw)] overflow-hidden rounded-xl border border-line bg-panel p-1.5 shadow-xl"
          style={{ top: popup.top, left: popup.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-faint">동영상 · 사진 앨범</p>
          {suggestions.isFetching && items.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> 찾는 중…
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-muted">일치하는 미디어가 없습니다.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {items.map((item, index) => (
                <button
                  type="button"
                  key={item.type + ':' + item.id}
                  className={
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ' +
                    (index === choice ? 'bg-raised text-ink' : 'text-muted hover:bg-raised')
                  }
                  onClick={() => selectMention(item)}
                >
                  {item.type === 'video' ? <Film size={15} /> : <Images size={15} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{item.label}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {item.type === 'video' ? '동영상' : '사진 앨범'} · {item.libraryName}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
