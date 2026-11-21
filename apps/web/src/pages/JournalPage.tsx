import { useEffect, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BookOpenText, CalendarDays, Check, Loader2, Menu, Plus, Trash2 } from 'lucide-react'
import type { AuthStatusDTO, JournalEntryDTO, JournalMentionDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { JournalSaveCoordinator, journalDraftKey, type JournalDraftStore, type JournalSaveStatus } from '../lib/journalDraft'
import { cn } from '../lib/cn'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { JournalEditor } from '../components/JournalEditor'
import { JournalTable } from '../components/JournalTable'
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

function MobileMenu() {
  const setSidebarOpen = useUi((state) => state.setSidebarOpen)
  return (
    <button
      type="button"
      onClick={() => setSidebarOpen(true)}
      title="사이드바 열기"
      aria-label="사이드바 열기"
      className="rounded-xl p-2.5 text-muted hover:bg-raised md:hidden"
    >
      <Menu size={19} />
    </button>
  )
}

export function JournalIndexPage() {
  const navigate = useNavigate()
  const toast = useUi((state) => state.toast)
  const queryClient = useQueryClient()
  const list = useInfiniteQuery({
    queryKey: ['journal', 'pages'],
    queryFn: ({ pageParam }) => api.journalEntries(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const entries = list.data?.pages.flatMap((page) => page.items) ?? []
  const create = useMutation({
    mutationFn: api.createJournalEntry,
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: ['journal'] })
      navigate('/journal/' + entry.id)
    },
    onError: () => toast('일지를 생성하지 못했습니다.', 'error'),
  })
  const createPage = () => {
    if (!create.isPending) create.mutate()
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas">
      <div className="flex min-h-full flex-col">
        <header className="flex min-h-[76px] items-center justify-between border-b border-line px-5 sm:px-8 lg:px-10">
          <div className="flex items-center gap-2">
            <MobileMenu />
            <BookOpenText size={20} className="text-accent" />
            <span className="text-[15px] font-semibold text-ink">일지</span>
          </div>
          <Button onClick={createPage} disabled={create.isPending}>
            <Plus size={15} /> 새 일지
          </Button>
        </header>
        <main className="workspace-page w-full flex-1 pt-12 sm:pt-14">
          <h1 className="text-[clamp(34px,4.5vw,52px)] font-bold tracking-tight text-ink">나의 일지</h1>
          <p className="mt-3 text-[15px] text-muted">생각을 페이지로 기록하고, 언제든 다시 열어보세요.</p>
          {list.isPending ? (
            <LoadingBlock />
          ) : list.isError ? (
            <div role="alert" className="mt-10 flex items-center gap-4 text-[13px] text-danger">
              <span>일지 목록을 불러오지 못했습니다.</span>
              <Button onClick={() => { void list.refetch() }}>다시 시도</Button>
            </div>
          ) : (
            <JournalTable entries={entries} creating={create.isPending} onCreate={createPage} />
          )}
          {list.hasNextPage ? (
            <div className="mt-7 flex justify-center">
              <Button disabled={list.isFetchingNextPage} onClick={() => { void list.fetchNextPage() }}>
                {list.isFetchingNextPage ? '불러오는 중…' : '이전 일지 더 보기'}
              </Button>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  )
}

function JournalDocument({ entry, userId }: { entry: JournalEntryDTO; userId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [status, setStatus] = useState<JournalSaveStatus>('saved')
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [model] = useState(() => {
    let storage: JournalDraftStore | null = null
    try {
      storage = window.localStorage
    } catch {
      // Browser storage can be denied, but authenticated server saves still work.
    }
    return new JournalSaveCoordinator({
      entry,
      store: storage,
      draftKey: journalDraftKey(userId, entry.id),
      persist: (value) => api.updateJournalEntry(entry.id, value),
      onStatus: setStatus,
      onSaved: (saved) => {
        // An outstanding save after logout must not repopulate another account's cache.
        const activeUserId = queryClient.getQueryData<AuthStatusDTO>(['auth'])?.user?.id
        if (activeUserId !== userId) return
        queryClient.setQueryData(['journal', 'entry', entry.id], saved)
        void queryClient.invalidateQueries({ queryKey: ['journal', 'recent'] })
        void queryClient.invalidateQueries({ queryKey: ['journal', 'pages'] })
      },
      onError: (_error, conflict) => {
        toast(
          conflict
            ? '다른 탭에서 일지가 변경됐습니다. 초안을 유지하고 충돌 해결을 요청합니다.'
            : '저장에 실패했습니다. 브라우저 초안을 보관하고 재시도합니다.',
          'error',
        )
      },
    })
  })
  const [title, setTitle] = useState(model.initial.title)
  const [body, setBody] = useState(model.initial.body)

  useEffect(() => { setStatus(model.initialStatus) }, [model])

  const editTitle = (value: string) => {
    setTitle(value)
    if (!model.edit({ ...model.current, title: value })) {
      toast('초안을 브라우저에 저장하지 못했습니다. 서버 저장 여부를 확인하세요.', 'error')
    }
  }
  const editBody = (value: string) => {
    if (value.length > 100_000) {
      toast('본문은 최대 10만 글자까지 저장할 수 있습니다.', 'error')
      return
    }
    setBody(value)
    if (!model.edit({ ...model.current, body: value })) {
      toast('초안을 브라우저에 저장하지 못했습니다. 서버 저장 여부를 확인하세요.', 'error')
    }
  }

  useEffect(() => {
    if (!model.hasUnsavedChanges || model.isConflicted) return
    const timer = window.setTimeout(() => { void model.save() }, 700)
    return () => window.clearTimeout(timer)
  }, [title, body, model])

  useEffect(() => {
    if (status !== 'error' || model.isConflicted || model.failedAttempts >= 4) return
    const delay = Math.min(15_000, 1500 * 2 ** Math.max(0, model.failedAttempts - 1))
    const timer = window.setTimeout(() => { void model.save() }, delay)
    return () => window.clearTimeout(timer)
  }, [status, model])

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void model.save()
      }
    }
    const online = () => {
      if (model.hasUnsavedChanges && !model.isConflicted) void model.save()
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!model.hasUnsavedChanges) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('online', online)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('online', online)
      window.removeEventListener('beforeunload', beforeUnload)
      // A draft is already written synchronously on every edit; this is best effort.
      void model.save()
    }
  }, [model])

  const exit = async () => {
    if (await model.save()) navigate('/journal')
  }

  const remove = async () => {
    if (deleting) return
    setDeleting(true)
    await model.beginDelete()
    try {
      await api.deleteJournalEntry(entry.id)
      model.forget()
      queryClient.removeQueries({ queryKey: ['journal', 'entry', entry.id] })
      void queryClient.invalidateQueries({ queryKey: ['journal', 'recent'] })
      void queryClient.invalidateQueries({ queryKey: ['journal', 'pages'] })
      navigate('/journal', { replace: true })
      toast('일지를 삭제했습니다.', 'success')
    } catch {
      model.cancelDelete()
      setDeleting(false)
      toast('일지 삭제에 실패했습니다.', 'error')
    }
  }

  const resetFromServer = async () => {
    if (!window.confirm('이 브라우저의 초안을 버리고 서버 내용을 불러올까요?')) return
    setResolving(true)
    try {
      const latest = await api.journalEntry(entry.id)
      model.resetToServer(latest)
      queryClient.setQueryData(['journal', 'entry', entry.id], latest)
      setTitle(latest.title)
      setBody(latest.body)
      setEditorEpoch((value) => value + 1)
    } catch {
      toast('서버의 최신 일지를 불러오지 못했습니다.', 'error')
    } finally {
      setResolving(false)
    }
  }

  const overwriteServer = async () => {
    if (!window.confirm('다른 탭의 수정 내용을 내 초안으로 덮어쓸까요?')) return
    setResolving(true)
    try {
      const latest = await api.journalEntry(entry.id)
      model.allowOverwrite(latest.updatedAt)
      await model.save()
    } catch {
      toast('서버의 최신 일지를 확인하지 못했습니다.', 'error')
    } finally {
      setResolving(false)
    }
  }

  const openMention = async (mention: JournalMentionDTO) => {
    if (!(await model.save())) return
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
      <header className="sticky top-0 z-10 flex h-[76px] items-center justify-between gap-3 border-b border-line bg-canvas/95 px-5 backdrop-blur-sm sm:px-8">
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
          <span aria-live="polite" className={cn('flex items-center gap-1 text-[11.5px] text-faint', (status === 'error' || status === 'conflict') && 'text-danger')}>
            {status === 'saving' ? <Loader2 size={12} className="animate-spin" /> : status === 'saved' ? <Check size={12} /> : null}
            {status === 'saving' ? '저장 중' : status === 'saved' ? '저장됨' : status === 'error' ? '저장 실패' : status === 'conflict' ? '편집 충돌' : '작성 중'}
          </span>
          {(status === 'error' || status === 'editing') ? (
            <button
              type="button"
              onClick={() => { void model.save() }}
              className="rounded-md px-2 py-1 text-[12px] text-accent hover:bg-raised"
            >
              지금 저장
            </button>
          ) : null}
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

      <div className="mx-auto w-full max-w-[1120px] px-[clamp(24px,6vw,96px)] pb-28 pt-[clamp(44px,6vw,86px)]">
        {status === 'conflict' ? (
          <div role="alert" className="mb-8 flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-panel-2 px-4 py-3">
            <div className="min-w-[200px] flex-1 text-[13px] text-ink">
              다른 탭이나 기기에서 수정된 일지야. 내 초안은 이 브라우저에 보관했어.
            </div>
            <Button disabled={resolving} onClick={() => { void resetFromServer() }}>서버 내용 사용</Button>
            <Button disabled={resolving} onClick={() => { void overwriteServer() }}>내 초안으로 덮어쓰기</Button>
          </div>
        ) : null}
        {status === 'error' ? (
          <div role="alert" className="mb-8 rounded-xl border border-danger/30 bg-panel-2 px-4 py-3 text-[12px] text-danger">
            저장 실패: 브라우저 초안을 보관하고 재시도 중이야.
            <button type="button" onClick={() => { void model.save() }} className="ml-3 underline">다시 저장</button>
          </div>
        ) : null}
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
          key={entry.id + ':' + editorEpoch}
          entryId={entry.id}
          initialBody={body}
          onChange={editBody}
          onBlurSave={() => { void model.save() }}
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
            <Button variant="danger" disabled={deleting} onClick={() => { void remove() }}>
              {deleting ? '삭제 중…' : '일지 삭제'}
            </Button>
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
  const queryClient = useQueryClient()
  const userId = queryClient.getQueryData<AuthStatusDTO>(['auth'])?.user?.id ?? 'unknown'
  const entry = useQuery({
    queryKey: ['journal', 'entry', id],
    queryFn: () => api.journalEntry(id!),
    enabled: Boolean(id),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  if (entry.isPending || entry.isFetching) return <LoadingBlock label="일지 불러오는 중" />
  if (entry.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5">
        <p className="text-[14px] text-muted">일지를 찾을 수 없습니다.</p>
        <Button onClick={() => navigate('/journal')}><ArrowLeft size={15} /> 일지 목록</Button>
      </div>
    )
  }
  return <JournalDocument key={entry.data.id} entry={entry.data} userId={userId} />
}
