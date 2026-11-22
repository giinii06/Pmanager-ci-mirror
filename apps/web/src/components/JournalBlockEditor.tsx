import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Code2, GripVertical, ImagePlus, Plus, Trash2, Type, UploadCloud } from 'lucide-react'
import {
  JOURNAL_DEFAULT_PROPERTIES, parseJournalDocument, serializeJournalDocument,
  type JournalBlock, type JournalBlockDocument, type JournalBlockKind, type JournalProperties,
} from '@mediavault/shared'
import { api } from '../lib/api'
import { randomToken } from '../lib/random'
import { useUi } from '../store/ui'

interface Props {
  entryId: string
  initialBody: string
  onChange: (serialized: string) => void
  onBlurSave: () => void
}

const OPTIONS: Array<{ value: JournalBlockKind; label: string }> = [
  { value: 'paragraph', label: '텍스트' },
  { value: 'heading1', label: '제목 1' },
  { value: 'heading2', label: '제목 2' },
  { value: 'heading3', label: '제목 3' },
  { value: 'bulleted', label: '글머리 기호' },
  { value: 'numbered', label: '번호 매기기' },
  { value: 'todo', label: '체크리스트' },
  { value: 'quote', label: '인용문' },
  { value: 'callout', label: '콜아웃' },
  { value: 'code', label: '코드' },
  { value: 'divider', label: '구분선' },
  { value: 'table', label: '표' },
  { value: 'image', label: '이미지' },
]

function makeBlock(type: JournalBlockKind = 'paragraph'): JournalBlock {
  return {
    id: randomToken(8), type, text: '', checked: false,
    ...(type === 'table' ? { cells: [['', ''], ['', '']] } : {}),
  }
}

const blockTextClasses: Record<string, string> = {
  paragraph: 'text-[16px] font-normal',
  heading1: 'text-[32px] font-bold tracking-tight',
  heading2: 'text-[25px] font-semibold tracking-tight',
  heading3: 'text-[20px] font-semibold',
  quote: 'border-l-[3px] border-accent pl-4 italic text-[17px]',
  code: 'rounded-lg bg-panel-2 p-3 font-mono text-[13px]',
  callout: 'rounded-lg bg-panel-2 p-4 text-[15px]',
  bulleted: 'text-[16px]',
  numbered: 'text-[16px]',
  todo: 'text-[16px]',
}

function statusLabel(status: JournalProperties['status']): string {
  return status === 'Done' ? '완료' : status === 'In progress' ? '진행 중' : '미시작'
}

export function JournalBlockEditor({ entryId, initialBody, onChange, onBlurSave }: Props) {
  const [document] = useState(() => parseJournalDocument(initialBody))
  const [blocks, setBlocks] = useState(document.blocks.length ? document.blocks : [makeBlock()])
  const [props, setProps] = useState<JournalProperties>(document.properties ?? JOURNAL_DEFAULT_PROPERTIES)
  const [tagInput, setTagInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [slashFor, setSlashFor] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dragId = useRef<string | null>(null)
  const latest = useRef<JournalBlockDocument>({
    version: 1, properties: document.properties,
    blocks: document.blocks.length ? document.blocks : [makeBlock()],
  })
  const toast = useUi((state) => state.toast)

  const commit = (transform: (prev: JournalBlockDocument) => JournalBlockDocument) => {
    const next = transform(latest.current)
    const body = serializeJournalDocument(next)
    if (body.length > 100_000) {
      toast('일지 전체 저장 용량(10만 글자)을 초과했습니다.', 'error')
      return
    }
    latest.current = next
    setBlocks(next.blocks)
    setProps(next.properties)
    onChange(body)
  }

  const editBlock = (id: string, update: Partial<JournalBlock>) => {
    commit((prev) => ({ ...prev, blocks: prev.blocks.map((block) =>
      block.id === id ? { ...block, ...update } : block,
    ) }))
  }

  const addBlock = (after: string | null, kind: JournalBlockKind = 'paragraph') => {
    const newBlock = makeBlock(kind)
    commit((prev) => {
      const index = prev.blocks.findIndex((block) => block.id === after)
      const target = index < 0 ? prev.blocks.length : index + 1
      const next = [...prev.blocks]
      next.splice(target, 0, newBlock)
      return { ...prev, blocks: next }
    })
    setSlashFor(null)
    requestAnimationFrame(() => window.document.getElementById('journal-block-' + newBlock.id)?.focus())
  }

  const removeBlock = (id: string) => {
    commit((prev) => ({
      ...prev,
      blocks: prev.blocks.length > 1
        ? prev.blocks.filter((block) => block.id !== id)
        : [makeBlock()],
    }))
  }

  const changeProperties = (next: Partial<JournalProperties>) => {
    commit((prev) => ({ ...prev, properties: { ...prev.properties, ...next } }))
  }

  const addTag = () => {
    const name = tagInput.trim().slice(0, 48)
    if (!name || props.tags.includes(name) || props.tags.length >= 24) return
    changeProperties({ tags: [...props.tags, name] })
    setTagInput('')
  }

  const uploadFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files).slice(0, 10)
    if (!selected.length) return
    setUploading(true)
    try {
      for (const file of selected) {
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
          toast('PNG·JPEG·WebP·GIF 이미지만 5MB 이하로 추가할 수 있습니다.', 'error')
          continue
        }
        const uploaded = await api.uploadJournalImage(entryId, file)
        commit((prev) => ({
          ...prev,
          blocks: [...prev.blocks, { ...makeBlock('image'), imageId: uploaded.id, caption: file.name }],
        }))
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '이미지를 업로드하지 못했습니다.', 'error')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const dropBlock = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    const source = dragId.current
    dragId.current = null
    if (!source || source === targetId) return
    event.preventDefault()
    commit((prev) => {
      const next = [...prev.blocks]
      const from = next.findIndex((block) => block.id === source)
      const to = next.findIndex((block) => block.id === targetId)
      if (from < 0 || to < 0) return prev
      const [item] = next.splice(from, 1)
      if (!item) return prev
      next.splice(to, 0, item)
      return { ...prev, blocks: next }
    })
  }

  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>, block: JournalBlock) => {
    if (event.key === 'Enter' && !event.shiftKey && block.type !== 'code') {
      event.preventDefault()
      addBlock(block.id)
    }
    if (event.key === 'Backspace' && block.text.length === 0 && blocks.length > 1) {
      event.preventDefault()
      removeBlock(block.id)
    }
    if (event.key === 'Escape') setSlashFor(null)
  }

  const onImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void uploadFiles(event.target.files)
  }

  return (
    <section className="journal-blocks space-y-5" aria-label="일지 블록 편집기"
      onPaste={(event) => {
        if (event.clipboardData.files.length > 0) {
          event.preventDefault()
          void uploadFiles(event.clipboardData.files)
        }
      }}>
      <div className="mb-7 flex flex-col gap-3 border-b border-line pb-7 text-[13px]">
        <div className="flex items-center gap-4">
          <span className="w-20 shrink-0 text-muted">상태</span>
          <select aria-label="상태" value={props.status}
            onChange={(event) => changeProperties({ status: event.target.value as JournalProperties['status'] })}
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-ink">
            <option value="Not started">미시작</option>
            <option value="In progress">진행 중</option>
            <option value="Done">완료</option>
          </select>
          <span className="text-faint">{statusLabel(props.status)}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="w-20 shrink-0 text-muted">날짜</span>
          <input aria-label="마감 날짜" type="date" value={props.dueDate ?? ''}
            onChange={(event) => changeProperties({ dueDate: event.target.value || null })}
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-ink" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-20 shrink-0 text-muted">태그</span>
          {props.tags.map((tag) => (
            <button key={tag} type="button" onClick={() => changeProperties({ tags: props.tags.filter((t) => t !== tag) })}
              className="rounded-full bg-accent/15 px-2.5 py-1 text-[12px] text-accent" title="태그 제거">
              {tag} ×
            </button>
          ))}
          <input aria-label="태그 추가" value={tagInput} maxLength={48}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag() } }}
            placeholder="+ 태그" className="min-w-20 w-32 bg-transparent text-ink outline-none placeholder:text-faint" />
          <button type="button" onClick={addTag} className="rounded-md px-2 py-1 text-muted hover:bg-raised">추가</button>
        </div>
        <div className="flex items-center gap-4">
          <span className="w-20 shrink-0 text-muted">페이지</span>
          <input aria-label="페이지 아이콘" maxLength={8} value={props.icon}
            onChange={(event) => changeProperties({ icon: event.target.value })}
            className="w-14 rounded-lg border border-line bg-panel-2 px-2 py-1 text-center text-[20px] text-ink" />
          <button type="button" aria-pressed={props.favorite} onClick={() => changeProperties({ favorite: !props.favorite })}
            className="rounded-lg px-2 py-1 text-muted hover:bg-raised">
            {props.favorite ? '★ 즐겨찾기' : '☆ 즐겨찾기'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[12px]">
        <button type="button" onClick={() => addBlock(null)} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-muted hover:bg-raised">
          <Plus size={14} /> 블록 추가
        </button>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading}
          className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-muted hover:bg-raised disabled:opacity-50">
          {uploading ? <UploadCloud size={14} className="animate-pulse" /> : <ImagePlus size={14} />}
          {uploading ? '업로드 중' : '사진 삽입'}
        </button>
        <span className="self-center text-faint">/ 명령어 · Shift+Enter 줄바꿈 · 드래그로 순서 변경</span>
        <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onImageChange} className="sr-only" aria-label="이미지 선택" />
      </div>

      <div className="space-y-1">
        {blocks.map((block, index) => (
          <div key={block.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropBlock(event, block.id)}
            className="group relative flex items-start gap-2 rounded-lg py-1 hover:bg-panel-2/40">
            <div className="flex shrink-0 items-center gap-0.5 pt-1 opacity-50 transition-opacity group-hover:opacity-100">
              <button type="button" draggable onDragStart={() => { dragId.current = block.id }} title="블록 순서 바꾸기"
                className="cursor-grab rounded p-1.5 text-muted hover:bg-raised"><GripVertical size={15} /></button>
              <button type="button" title="아래에 블록 추가" onClick={() => addBlock(block.id)}
                className="rounded p-1.5 text-muted hover:bg-raised"><Plus size={15} /></button>
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-1 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <select aria-label="블록 종류" value={block.type}
                  onChange={(event) => editBlock(block.id, { type: event.target.value as JournalBlockKind })}
                  className="rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-muted">
                  {OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <button type="button" onClick={() => removeBlock(block.id)} title="블록 삭제"
                  className="rounded p-1 text-faint hover:bg-danger/10 hover:text-danger"><Trash2 size={13} /></button>
              </div>

              {block.type === 'divider' ? <hr className="my-5 border-line" /> :
              block.type === 'image' ? (
                <figure className="max-w-full">
                  {block.imageId ? (
                    <img src={'/api/journal/' + encodeURIComponent(entryId) + '/images/' + encodeURIComponent(block.imageId)}
                      alt={block.caption || '일지 이미지'} loading="lazy"
                      className="max-h-[650px] max-w-full rounded-lg border border-line object-contain" />
                  ) : <button type="button" onClick={() => fileInput.current?.click()}
                    className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-muted">
                    <ImagePlus size={20} /> 사진 선택
                  </button>}
                  <input aria-label="이미지 설명" value={block.caption ?? ''}
                    onChange={(event) => editBlock(block.id, { caption: event.target.value })}
                    onBlur={onBlurSave} placeholder="이미지 설명"
                    className="mt-1 w-full bg-transparent px-2 py-1 text-[12px] text-muted outline-none" />
                </figure>
              ) : block.type === 'table' ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[13px]">
                    <tbody>{(block.cells ?? [['',''],['','']]).map((row, rowIndex) => (
                      <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="min-w-[100px] border border-line p-0">
                          <input value={cell} onBlur={onBlurSave} aria-label={'표 ' + (rowIndex + 1) + '행 ' + (cellIndex + 1) + '열'}
                            onChange={(event) => {
                              const cells = (block.cells ?? [['',''],['','']]).map((r) => [...r])
                              cells[rowIndex]![cellIndex] = event.target.value
                              editBlock(block.id, { cells })
                            }}
                            className="w-full bg-transparent p-2 text-ink outline-none focus:bg-panel-2" />
                        </td>
                      ))}</tr>
                    ))}</tbody>
                  </table>
                  <button type="button" onClick={() => {
                    const cells = (block.cells ?? [['',''],['','']]).map((r) => [...r])
                    cells.push(Array(cells[0]?.length ?? 2).fill(''))
                    editBlock(block.id, { cells })
                  }} className="mr-3 mt-2 text-[12px] text-muted hover:text-ink">+ 행 추가</button>
                  <button type="button" onClick={() => {
                    const cells = (block.cells ?? [['',''],['','']]).map((r) => [...r, ''])
                    editBlock(block.id, { cells })
                  }} className="mt-2 text-[12px] text-muted hover:text-ink">+ 열 추가</button>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {block.type === 'todo' ? (
                    <input type="checkbox" checked={block.checked ?? false}
                      onChange={(event) => editBlock(block.id, { checked: event.target.checked })}
                      className="mt-2 accent-accent" aria-label="체크리스트 완료" />
                  ) : block.type === 'bulleted' ? <span className="mt-1 text-xl text-ink">•</span> :
                    block.type === 'numbered' ? <span className="mt-1 text-muted">{index + 1}.</span> :
                    block.type === 'callout' ? <span className="mt-1">💡</span> :
                    block.type === 'code' ? <Code2 size={14} className="mt-1 text-muted" /> :
                    block.type.startsWith('heading') ? <Type size={14} className="mt-2 text-faint" /> : null}
                  <div className="min-w-0 flex-1">
                    <textarea id={'journal-block-' + block.id} rows={Math.max(1, block.text.split('\n').length)}
                      value={block.text}
                      onChange={(event) => {
                        editBlock(block.id, { text: event.target.value })
                        setSlashFor(event.target.value === '/' ? block.id : null)
                      }}
                      onKeyDown={(event) => onTextKey(event, block)}
                      onBlur={onBlurSave}
                      placeholder={block.type.startsWith('heading') ? '제목' : '내용을 입력하거나 / 로 명령어 선택'}
                      className={'w-full resize-y bg-transparent py-1 leading-relaxed text-ink outline-none placeholder:text-faint/60 ' + (blockTextClasses[block.type] ?? 'text-[16px]')} />
                    {slashFor === block.id ? (
                      <div className="z-20 grid max-h-52 grid-cols-2 gap-1 overflow-y-auto rounded-xl border border-line bg-panel p-2 shadow-xl">
                        {OPTIONS.map((option) => (
                          <button type="button" key={option.value} onClick={() => { editBlock(block.id, { type: option.value, text: '' }); setSlashFor(null) }}
                            className="rounded-md px-3 py-2 text-left text-[12px] text-muted hover:bg-raised hover:text-ink">{option.label}</button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => addBlock(blocks.at(-1)?.id ?? null)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-2 text-[13px] text-faint hover:bg-panel-2 hover:text-ink">
        <Plus size={15} /> 블록을 추가하세요
      </button>
    </section>
  )
}
