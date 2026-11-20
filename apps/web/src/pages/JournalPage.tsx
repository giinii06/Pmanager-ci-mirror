import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BookOpenText, CalendarDays, Check, FileText, Loader2, Menu, Plus, Trash2 } from 'lucide-react'
import type { JournalEntryDTO, JournalMentionDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { JournalEditor } from '../components/JournalEditor'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { LoadingBlock } from '../components/ui/Spinner'

function pageDate(timestamp: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(timestamp))
}

function shortDate(timestamp: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function MobileMenu() {
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  return (
    <button
      type="button"
      onClick={() => setSidebarOpen(true)}
      title="사이드바 열기"
      aria-label="사이드바 열기"
      className="rounded-lg p-2 text-muted hover:bg-raised md:hidden"
    >
      <Menu size={19} />
    </button>
  )
}

export function JournalIndexPage() {
  const navigate = useNavigate()
  const toast = useUi((state) => state.toast)
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['journal', 'list'], queryFn: api.journalEntries })
  const create = useMutation({
    mutationFn: api.createJournalEntry,
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: ['journal', 'list'] })
      navigate('/journal/' + entry.id)
    },
    onError: () => toast('일지를 생성하지 못했습니다.', 'error'),
  })

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas">
      <div className="flex min-h-full flex-col">
        <header className="flex min-h-14 items-center justify-between border-b border-line px-5 sm:px-10">
          <div className="flex items-center gap-2">
            <MobileMenu />
            <BookOpenText size={17} className="text-accent" />
            <span className="text-[13px] font-semibold text-ink">일지</span>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus size={15} /> 새 일지
          </Button>
        </header>
        <div className="w-full flex-1 px-[min(7vw,100px)] py-12">
          <p className="mb-2 text-[12px] font-medium tracking-widest text-faint">MY JOURNAL</p>
          <h1 className="text-[clamp(30px,4vw,48px)] font-bold tracking-tight text-ink">나의 일지</h1>
          <p className="mt-3 text-[14px] text-muted">기록한 날짜와 함께 생각을 모아두세요. 새 페이지의 날짜는 만드는 순간 정해집니다.</p>
          {list.isPending ? (
            <LoadingBlock />
          ) : list.isError ? (
            <p className="mt-12 text-danger">일지 목록을 불러오지 못했습니다.</p>
          ) : list.data.items.length === 0 ? (
            <div className="mt-14 flex flex-col items-start gap-5 rounded-2xl border border-dashed border-line p-9">
              <FileText size={26} className="text-faint" />
              <div>
                <p className="font-semibold text-ink">아직 작성한 일지가 없어요.</p>
                <p className="mt-1 text-[13px] text-muted">+ 버튼으로 첫 페이지를 만들어 보세요.</p>
              </div>
              <Button onClick={() => create.mutate()} disabled={create.isPending}><Plus size={15} /> 첫 일지 만들기</Button>
            </div>
          ) : (
            <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {list.data.items.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  onClick={() => navigate('/journal/' + entry.id)}
                  className="group min-h-36 rounded-2xl border border-line bg-panel p-5 text-left transition-colors hover:border-line-strong hover:bg-panel-2"
                >
                  <span className="flex items-center gap-1.5 text-[12px] text-faint">
                    <CalendarDays size={13} /> {pageDate(entry.createdAt)}
                  </span>
                  <span className="mt-5 block truncate text-[17px] font-semibold text-ink">
                    {entry.title || '제목 없음'}
                  </span>
                  <span className="mt-2 block text-[11px] text-faint">수정 {shortDate(entry.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function JournalDocument({ entry }: { entry: JournalEntryDTO }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [title, setTitle] = useState(entry.title)
  const [body, setBody] = useState(entry.body)
  const [status, setStatus] = useState<'saved' | 'editing' | 'saving' | 'error'>('saved')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const latestRef = useRef({ title: entry.title, body: entry.body })
  const persistedRef = useRef(JSON.stringify([entry.title, entry.body]))
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const deletingRef = useRef(false)

  const editTitle = (value: string) => {
    setTitle(value)
    latestRef.current = { ...latestRef.current, title: value }
    setStatus('editing')
  }

  const editBody = (value: string) => {
    if (value.length > 100_000) {
      toast('본문은 10만 글자까지 저장할 수 있습니다.', 'error')
      return
    }
    setBody(value)
    latestRef.current = { ...latestRef.current, body: value }
    setStatus('editing')
  }

  const save = useCallback((): Promise<boolean> => {
    const task = saveQueueRef.current.then(async () => {
      if (deletingRef.current) return true
      // Coalesce rapid edits: send the freshest text after any earlier save.
      const value = latestRef.current
      const serialized = JSON.stringify([value.title, value.body])
      if (serialized === persistedRef.current) return true
      setStatus('saving')
      try {
        await api.updateJournalEntry(entry.id, value)
        persistedRef.current = serialized
        if (JSON.stringify([latestRef.current.title, latestRef.current.body]) === serialized) {
          setStatus('saved')
        } else {
          setStatus('editing')
        }
        void queryClient.invalidateQueries({ queryKey: ['journal', 'list'] })
        return true
      } catch {
        setStatus('error')
        toast('일지를 저장하지 못했습니다. 다시 저장해 주세요.', 'error')
        return false
      }
    })
    saveQueueRef.current = task.then(() => undefined, () => undefined)
    return task
  }, [entry.id, queryClient, toast])

  useEffect(() => {
    if (JSON.stringify([title, body]) === persistedRef.current) return
    const timer = window.setTimeout(() => { void save() }, 700)
    return () => window.clearTimeout(timer)
  }, [title, body, save])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  useEffect(() => () => { void save() }, [save])

  const exit = async () => {
    if (await save()) navigate('/journal')
  }

  const remove = async () => {
    // Wait for in-flight writes so they never race the DELETE request.
    await saveQueueRef.current
    deletingRef.current = true
    try {
      await api.deleteJournalEntry(entry.id)
      void queryClient.invalidateQueries({ queryKey: ['journal', 'list'] })
      queryClient.removeQueries({ queryKey: ['journal', 'entry', entry.id] })
      navigate('/journal', { replace: true })
      toast('일지를 삭제했습니다.', 'success')
    } catch {
      deletingRef.current = false
      toast('일지를 삭제하지 못했습니다.', 'error')
    }
  }

  const openMention = async (mention: JournalMentionDTO) => {
    if (!(await save())) return
    if (mention.type === 'album') {
      navigate('/folders/' + encodeURIComponent(mention.id))
      return
    }
    try {
      const asset = await api.asset(mention.id)
      useViewer.getState().open([asset], 0)
    } catch {
      toast('동영상을 열지 못했습니다. 삭제되었을 수 있습니다.', 'error')
    }
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur-sm sm:px-7">
        <div className="flex min-w-0 items-center gap-1.5">
          <MobileMenu />
          <button
            type="button"
            onClick={() => { void exit() }}
            aria-label="일지 나가기"
            title="일지 나가기"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12.5px] text-muted hover:bg-raised hover:text-ink"
          >
            <ArrowLeft size={16} /> 나가기
          </button>
          <span className="ml-2 hidden truncate text-[12px] text-faint sm:block">
            / {title || '제목 없음'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span aria-live="polite" className={cn('flex items-center gap-1 text-[11.5px] text-faint', status === 'error' && 'text-danger')}>
            {status === 'saving' ? <Loader2 size={12} className="animate-spin" /> : status === 'saved' ? <Check size={12} /> : null}
            {status === 'saving' ? '저장 중' : status === 'saved' ? '저장됨' : status === 'error' ? '저장 실패' : '작성 중'}
          </span>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label="일지 삭제"
            title="일지 삭제"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-muted hover:bg-red-500/10 hover:text-danger"
          >
            <Trash2 size={15} /> <span className="hidden sm:inline">삭제</span>
          </button>
        </div>
      </header>

      <div className="w-full px-[clamp(22px,7vw,120px)] pb-28 pt-[clamp(42px,7vw,96px)]">
        <div className="mb-8 flex items-center gap-2 text-[13px] text-faint">
          <CalendarDays size={17} />
          <time dateTime={entry.createdAt} title="이 페이지를 만든 날짜입니다.">
            {pageDate(entry.createdAt)}
          </time>
          <span className="ml-2 rounded-md bg-panel-2 px-2 py-0.5 text-[11px]">
            생성 {new Date(entry.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <input
          aria-label="일지 제목"
          value={title}
          maxLength={160}
          onChange={(event) => editTitle(event.target.value)}
          placeholder="제목 없음"
          className="w-full border-0 bg-transparent py-2 text-[clamp(32px,4.7vw,60px)] font-bold leading-tight tracking-tight text-ink outline-none placeholder:text-faint/65 focus:outline-none"
        />
        <div className="mb-10 mt-7 h-px w-full bg-line" />
        <JournalEditor
          entryId={entry.id}
          initialBody={entry.body}
          onChange={editBody}
          onBlurSave={() => { void save() }}
          onOpenMention={(mention) => { void openMention(mention) }}
        />
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="이 일지를 삭제할까요?"
        description="작성한 제목과 본문이 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>취소</Button>
            <Button variant="danger" onClick={() => { void remove() }}>일지 삭제</Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">{title || '제목 없음'} · {pageDate(entry.createdAt)}</p>
      </Dialog>
    </div>
  )
}

export function JournalEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const entry = useQuery({
    queryKey: ['journal', 'entry', id],
    queryFn: () => api.journalEntry(id!),
    enabled: Boolean(id),
    staleTime: Infinity,
  })
  if (entry.isPending) return <LoadingBlock label="일지 불러오는 중" />
  if (entry.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5">
        <p className="text-[14px] text-muted">일지를 찾을 수 없습니다.</p>
        <Button onClick={() => navigate('/journal')}><ArrowLeft size={15} /> 일지 목록</Button>
      </div>
    )
  }
  return <JournalDocument key={entry.data.id} entry={entry.data} />
}
