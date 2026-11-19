import { useEffect, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Play, Trash2, TriangleAlert } from 'lucide-react'
import type { AssetDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { formatAgo, formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Input } from './ui/Input'
import { Spinner } from './ui/Spinner'

/** Mirrors the API's caps; the server rejects anything longer with a 400. */
const TITLE_MAX = 120
const NOTE_MAX = 2000

function clock(ms: number): string {
  return formatDuration(ms) || '0:00'
}

export function BookmarkDialog({
  open,
  onClose,
  asset,
  videoRef,
}: {
  open: boolean
  onClose: () => void
  asset: AssetDTO
  videoRef: RefObject<HTMLVideoElement | null>
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [positionMs, setPositionMs] = useState(0)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const bookmarks = useQuery({
    queryKey: ['bookmarks', asset.id],
    queryFn: () => api.bookmarks(asset.id),
    enabled: open,
  })

  // The mark belongs to the frame the user was looking at when they opened this,
  // not to wherever playback has drifted while the dialog sat open.
  useEffect(() => {
    if (!open) return
    const element = videoRef.current
    const ms =
      element && Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) : 0
    setPositionMs(ms)
    setTitle('')
    setNote('')
    setError(null)
  }, [open, videoRef])

  const create = useMutation({
    mutationFn: () =>
      api.createBookmark(asset.id, {
        positionMs,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks', asset.id] })
      setTitle('')
      setNote('')
      toast(`${clock(positionMs)}에 북마크를 남겼습니다.`, 'success')
    },
    onError: (err) => setError(err instanceof Error ? err.message : '북마크를 남기지 못했습니다.'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteBookmark(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks', asset.id] })
      toast('북마크를 지웠습니다.')
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : '북마크를 지우지 못했습니다.', 'error'),
  })

  const seek = (ms: number) => {
    const element = videoRef.current
    if (!element) return
    element.currentTime = ms / 1000
    void element.play().catch(() => undefined)
  }

  const list = bookmarks.data?.bookmarks ?? []

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="타임스탬프 북마크"
      description={`${asset.filename} · 지금 ${clock(positionMs)}`}
      className="w-[min(560px,94vw)]"
      footer={<Button onClick={onClose}>닫기</Button>}
    >
      <div className="space-y-3.5">
        <div className="space-y-2 rounded-xl border border-line bg-panel-2/60 p-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-2 py-1 text-[12px] font-medium tabular-nums text-accent">
              <Bookmark size={12} />
              {clock(positionMs)}
            </span>
            <span className="text-[11.5px] text-faint">이 위치에 남깁니다.</span>
          </div>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="제목 (선택)"
            maxLength={TITLE_MAX}
            className="h-8 text-[12px]"
          />
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="메모 (선택)"
            maxLength={NOTE_MAX}
            className="h-8 text-[12px]"
          />
          {error ? (
            <p className="text-[11.5px] text-danger">{error}</p>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={create.isPending}
            onClick={() => {
              setError(null)
              create.mutate()
            }}
          >
            <Bookmark size={12} />
            {create.isPending ? '남기는 중' : '북마크 남기기'}
          </Button>
        </div>

        {bookmarks.isPending ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[12.5px] text-muted">
            <Spinner />
            불러오는 중
          </div>
        ) : list.length === 0 ? (
          <p className="px-1 text-[12px] text-faint">아직 이 영상에 북마크가 없습니다.</p>
        ) : (
          <ul className="space-y-1">
            {list.map((bookmark) => (
              <li
                key={bookmark.id}
                className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-2"
              >
                <button
                  type="button"
                  onClick={() => seek(bookmark.positionMs)}
                  title="이 위치로 이동"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-raised px-2 py-1 text-[11.5px] font-medium tabular-nums text-ink transition-colors hover:bg-[#242832]"
                >
                  <Play size={10} />
                  {clock(bookmark.positionMs)}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-ink">
                    {bookmark.title ?? '제목 없음'}
                  </p>
                  {bookmark.note ? (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-muted">
                      {bookmark.note}
                    </p>
                  ) : null}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
                    <span>{formatAgo(bookmark.createdAt)}</span>
                    {bookmark.stale ? (
                      <span className="inline-flex items-center gap-1 text-[#fbbf24]">
                        <TriangleAlert size={10} />
                        파일이 바뀌어 위치가 다를 수 있습니다
                      </span>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="북마크 삭제"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(bookmark.id)}
                  className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
