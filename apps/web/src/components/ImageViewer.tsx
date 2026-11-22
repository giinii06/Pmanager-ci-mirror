import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import type { AssetDTO, FolderDTO } from '@mediavault/shared'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  Info,
  Plus,
  Tag,
  Maximize2,
  Minimize2,
  Share2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api, type FolderDetail } from '../lib/api'
import { patchAssetInCaches } from '../lib/cachePatch'
import { cn } from '../lib/cn'
import { formatBytes, formatCount, formatDate } from '../lib/format'
import { useMeasuredElement } from '../lib/hooks'
import { buildCoverActions, fitPage, groupViewerItems, pageAt, VIEWER_GAP } from '../lib/viewerPages'
import { useUi } from '../store/ui'
import { assetUrl } from '../lib/mediaRoutes'
import { ImageSlot } from './ImageSlot'
import { useImageFullscreen } from './useImageFullscreen'
import { IconButton } from './ui/IconButton'

/** A keypress right after leaving fullscreen must not also close the viewer. */
const FULLSCREEN_EXIT_GRACE_MS = 350

export function ImageViewer({
  asset,
  items,
  index,
  libraryName,
  closeRef,
  onClose,
  onSelect,
}: {
  asset: AssetDTO
  items: AssetDTO[]
  index: number
  libraryName?: string
  closeRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSelect: (asset: AssetDTO) => void
}) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [showInfo, setShowInfo] = useState(false)
  const [fullRes, setFullRes] = useState(false)
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>({})
  const [tagInput, setTagInput] = useState('')
  const tagsQuery = useQuery({
    queryKey: ['tags', 'image'],
    queryFn: () => api.tags('image'),
  })
  const updateImageTag = (updated: AssetDTO) => {
    patchAssetInCaches(queryClient, updated)
    void queryClient.invalidateQueries({ queryKey: ['tags', 'image'] })
  }
  const attachTag = useMutation({
    mutationFn: (payload: { tagId?: string; name?: string }) => api.attachTag(asset.id, payload),
    onSuccess: ({ asset: updated }) => {
      updateImageTag(updated)
      setTagInput('')
    },
    onError: (error) => toast(error instanceof Error ? error.message : '사진 태그를 추가하지 못했습니다.', 'error'),
  })
  const detachTag = useMutation({
    mutationFn: (tagId: string) => api.detachTag(asset.id, tagId),
    onSuccess: ({ asset: updated }) => updateImageTag(updated),
    onError: () => toast('사진 태그를 제거하지 못했습니다.', 'error'),
  })
  const stage = useMeasuredElement<HTMLDivElement>()
  const { mode, active: fullscreenActive, toggle: toggleFullscreen, exit: exitFullscreen } =
    useImageFullscreen(stage.ref)
  const exitedAt = useRef(0)
  const wasFullscreen = useRef(false)
  const viewedIds = useRef(new Set<string>())

  const room = useMemo(
    () => ({ width: stage.width, height: stage.height }),
    [stage.width, stage.height],
  )
  const pages = useMemo(() => groupViewerItems(items, room), [items, room])
  const pageIndex = pageAt(pages, index)
  const page = pages[pageIndex] ?? { start: index, end: index + 1 }
  const pageItems = items.slice(page.start, page.end)
  const sizes = useMemo(() => fitPage(items, page, room), [items, page, room])
  const visibleItems = pageItems.length > 0 ? pageItems : [asset]
  const coverActions = useMemo(
    () => buildCoverActions(visibleItems, fullscreenActive),
    [visibleItems, fullscreenActive],
  )

  const setCover = useMutation({
    mutationFn: ({ folderId, assetId }: { folderId: string; assetId: string }) =>
      api.setFolderCover(folderId, assetId),
    onSuccess: (updated, vars) => {
      setPinnedCovers((prev) => ({
        ...prev,
        [updated.id]: updated.coverAssetId ?? vars.assetId,
      }))
      queryClient.setQueriesData<FolderDTO[]>({ queryKey: ['folders'] }, (list) =>
        list?.map((f) => (f.id === updated.id ? updated : f)),
      )
      queryClient.setQueryData<FolderDetail>(['folder', updated.id], (prev) =>
        prev ? { ...prev, folder: updated } : prev,
      )
      void queryClient.invalidateQueries({ queryKey: ['folders'] })
      void queryClient.invalidateQueries({ queryKey: ['folder'] })
      toast('폴더 썸네일로 설정했습니다.', 'success')
    },
    onError: (err) =>
      toast(
        err instanceof Error ? err.message : '폴더 썸네일을 변경하지 못했습니다.',
        'error',
      ),
  })

  const resolveCoverAssetId = (folderId: string): string | null => {
    const local = pinnedCovers[folderId]
    if (local) return local
    const detail = queryClient.getQueryData<FolderDetail>(['folder', folderId])
    if (detail?.folder.coverAssetId) return detail.folder.coverAssetId
    for (const [, list] of queryClient.getQueriesData<FolderDTO[]>({ queryKey: ['folders'] })) {
      const match = list?.find((f) => f.id === folderId)
      if (match?.coverAssetId) return match.coverAssetId
    }
    return null
  }

  useEffect(() => {
    setShowInfo(false)
    setFullRes(false)
    setTagInput('')
  }, [asset.id])

  useEffect(() => {
    const visibleIds = pageItems.length > 0 ? pageItems.map((item) => item.id) : [asset.id]
    for (const id of visibleIds) {
      if (viewedIds.current.has(id)) continue
      viewedIds.current.add(id)
      api
        .incrementView(id)
        .then((updated) => {
          patchAssetInCaches(queryClient, updated)
          queryClient.invalidateQueries({ queryKey: ['folders'] })
        })
        .catch(() => {
          viewedIds.current.delete(id)
        })
    }
  }, [asset.id, pageItems, queryClient])

  useEffect(() => {
    if (wasFullscreen.current && !fullscreenActive) exitedAt.current = Date.now()
    wasFullscreen.current = fullscreenActive
  }, [fullscreenActive])

  const goTo = useCallback(
    (target: number) => {
      const range = pages[target]
      const item = range ? items[range.start] : undefined
      if (item) onSelect(item)
    },
    [items, onSelect, pages],
  )
  const goPrev = useCallback(() => goTo(pageIndex - 1), [goTo, pageIndex])
  const goNext = useCallback(() => goTo(pageIndex + 1), [goTo, pageIndex])
  const canPrev = pageIndex > 0
  const canNext = pageIndex < pages.length - 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if (event.key === 'Escape') {
        if (fullscreenActive || Date.now() - exitedAt.current < FULLSCREEN_EXIT_GRACE_MS) {
          exitFullscreen()
          return
        }
        onClose()
        return
      }
      if (event.key === 'ArrowRight') {
        goNext()
        return
      }
      if (event.key === 'ArrowLeft') {
        goPrev()
        return
      }
      if (event.key.toLowerCase() === 'i') setShowInfo((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exitFullscreen, fullscreenActive, goNext, goPrev, onClose])

  useEffect(() => {
    for (const offset of [-1, 1]) {
      const range = pages[pageIndex + offset]
      if (!range) continue
      for (let itemIndex = range.start; itemIndex < range.end; itemIndex += 1) {
        const item = items[itemIndex]
        if (!item || item.kind !== 'image') continue
        const image = new Image()
        image.src = item.previewUrl
      }
    }
  }, [items, pageIndex, pages])

  const paired = pageItems.length > 1
  const counter = paired ? `${page.start + 1}–${page.end}` : `${index + 1}`

  return (
    <>
      {fullscreenActive ? null : (
        <div className="relative z-20 flex min-h-16 items-center justify-between gap-4 bg-gradient-to-b from-black/75 to-transparent px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="rounded-full p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X size={19} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-white">{asset.filename}</p>
              <p className="truncate text-[11.5px] text-white/45">
                {formatDate(asset.takenAt)} · 조회수 {formatCount(asset.viewCount)}회
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {coverActions.length > 0 ? (
              <div className="mr-1 flex items-center gap-1">
                {coverActions.map((action) => {
                  const isCurrent = resolveCoverAssetId(action.folderId) === action.assetId
                  const isPending =
                    setCover.isPending &&
                    setCover.variables?.folderId === action.folderId &&
                    setCover.variables?.assetId === action.assetId
                  return (
                    <button
                      key={action.key}
                      type="button"
                      disabled={isPending}
                      onClick={() =>
                        setCover.mutate({ folderId: action.folderId, assetId: action.assetId })
                      }
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-medium leading-none whitespace-nowrap transition-colors disabled:opacity-50',
                        isCurrent
                          ? 'border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                          : 'border-white/15 bg-white/[0.06] text-white/80 hover:border-white/30 hover:bg-white/14 hover:text-white',
                      )}
                    >
                      {isCurrent ? <Check size={12} /> : <ImageIcon size={12} />}
                      <span>{action.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            <IconButton
              label={fullRes ? '미리보기 화질로 보기' : '원본 화질로 보기'}
              active={fullRes}
              onClick={() => setFullRes((value) => !value)}
            >
              {fullRes ? <ZoomOut size={17} /> : <ZoomIn size={17} />}
            </IconButton>
            <IconButton
              label={fullscreenActive ? '전체화면 종료' : '전체화면'}
              active={fullscreenActive}
              onClick={toggleFullscreen}
            >
              {fullscreenActive ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </IconButton>
            <IconButton
              label="사진 태그"
              active={showInfo}
              onClick={() => setShowInfo((value) => !value)}
            >
              <Tag size={17} />
            </IconButton>
            <IconButton
              label="정보"
              active={showInfo}
              onClick={() => setShowInfo((value) => !value)}
            >
              <Info size={17} />
            </IconButton>
            <IconButton label="사진 링크 복사" onClick={() => {
              void navigator.clipboard.writeText(window.location.origin + assetUrl('image', asset.id))
                .then(() => toast('사진 링크를 복사했습니다.', 'success'))
                .catch(() => toast('사진 링크를 복사할 수 없습니다.', 'error'))
            }}><Share2 size={17} /></IconButton>
            <a
              href={`${asset.streamUrl}&download=1`}
              download={asset.filename}
              aria-label="원본 내려받기"
              title="원본 내려받기"
              className="rounded-full p-2 text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Download size={17} />
            </a>
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center px-3 pb-3 sm:px-16">
          {canPrev && !fullscreenActive ? (
            <button
              type="button"
              onClick={goPrev}
              aria-label="이전"
              className="absolute left-1 z-20 rounded-full bg-black/40 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white sm:left-4"
            >
              <ChevronLeft size={20} />
            </button>
          ) : null}

          <div
            ref={stage.attach}
            className={cn(
              'relative flex h-full min-h-0 min-w-0 flex-1 items-center justify-center',
              fullscreenActive && 'bg-black',
              mode === 'pseudo' && 'fixed inset-0 z-[90]',
            )}
          >
            <div className="flex h-full w-full items-center justify-center" style={{ gap: VIEWER_GAP }}>
              {pageItems.map((item, offset) => {
                const slot = sizes[offset]
                if (item.kind !== 'image' || !slot) return null
                return (
                  <ImageSlot
                    key={item.id}
                    asset={item}
                    width={slot.width}
                    height={slot.height}
                    full={fullRes}
                    selected={paired && item.id === asset.id}
                    onSelect={paired ? () => onSelect(item) : undefined}
                  />
                )
              })}
            </div>
          </div>

          {canNext && !fullscreenActive ? (
            <button
              type="button"
              onClick={goNext}
              aria-label="다음"
              className="absolute right-1 z-20 rounded-full bg-black/40 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white sm:right-4"
            >
              <ChevronRight size={20} />
            </button>
          ) : null}
        </div>

        <AnimatePresence>
          {showInfo && !fullscreenActive ? (
            <motion.aside
              key="info"
              initial={{ x: 24, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 24, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="w-[340px] max-w-[86vw] shrink-0 overflow-y-auto border-l border-white/10 bg-[#0b0c0f]/97 px-6 py-7"
            >
              <h3 className="text-[13px] font-semibold text-ink">정보</h3>
              <dl className="mt-4 space-y-3.5 text-[12.5px]">
                <div>
                  <dt className="text-faint">파일 이름</dt>
                  <dd className="mt-0.5 break-all text-ink">{asset.filename}</dd>
                </div>
                <div>
                  <dt className="text-faint">조회수</dt>
                  <dd className="mt-0.5 tabular-nums text-ink">{formatCount(asset.viewCount)}회</dd>
                </div>
                <div>
                  <dt className="text-faint">촬영일</dt>
                  <dd className="mt-0.5 text-ink">{formatDate(asset.takenAt)}</dd>
                </div>
                <div>
                  <dt className="text-faint">해상도</dt>
                  <dd className="mt-0.5 tabular-nums text-ink">
                    {asset.width && asset.height ? `${asset.width} × ${asset.height}` : '알 수 없음'}
                  </dd>
                </div>
                <div>
                  <dt className="text-faint">용량</dt>
                  <dd className="mt-0.5 tabular-nums text-ink">{formatBytes(asset.sizeBytes)}</dd>
                </div>
                <div>
                  <dt className="text-faint">형식</dt>
                  <dd className="mt-0.5 text-ink">{asset.mimeType}</dd>
                </div>
                <div>
                  <dt className="text-faint">라이브러리</dt>
                  <dd className="mt-0.5 text-ink">{libraryName ?? asset.libraryId}</dd>
                </div>
                <div>
                  <dt className="text-faint">경로</dt>
                  <dd className="mt-0.5 break-all text-muted">{asset.relativePath}</dd>
                </div>
              </dl>
              <div className="mt-6 border-t border-white/10 pt-5">
                <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                  <Tag size={14} /> 사진 태그
                </h4>
                <div className="mt-3 flex flex-wrap gap-2">
                  {asset.tags.map((tag) => (
                    <span key={tag.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[12px] text-ink">
                      {tag.name}
                      <button
                        type="button"
                        aria-label={`${tag.name} 사진 태그 제거`}
                        onClick={() => detachTag.mutate(tag.id)}
                        disabled={detachTag.isPending}
                        className="rounded-full p-0.5 text-muted hover:text-ink"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {asset.tags.length === 0 ? (
                    <span className="text-[12px] text-faint">태그 없음</span>
                  ) : null}
                </div>
                <form
                  className="mt-3 flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (tagInput.trim()) attachTag.mutate({ name: tagInput.trim() })
                  }}
                >
                  <input
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    placeholder="새 사진 태그"
                    aria-label="새 사진 태그 이름"
                    className="h-9 w-full min-w-0 rounded-lg border border-line bg-panel px-2.5 text-[12px] text-ink"
                  />
                  <button
                    type="submit"
                    disabled={!tagInput.trim() || attachTag.isPending}
                    aria-label="사진 태그 추가"
                    className="inline-flex h-9 items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50"
                  >
                    <Plus size={13} /> 추가
                  </button>
                </form>
                <select
                  aria-label="기존 사진 태그 선택"
                  value=""
                  disabled={attachTag.isPending}
                  onChange={(event) => {
                    if (event.target.value) attachTag.mutate({ tagId: event.target.value })
                  }}
                  className="mt-2 h-9 w-full rounded-lg border border-line bg-panel px-2.5 text-[12px] text-ink"
                >
                  <option value="">기존 사진 태그 선택...</option>
                  {(tagsQuery.data?.tags ?? [])
                    .filter((tag) => !asset.tags.some((attached) => attached.id === tag.id))
                    .map((tag) => (
                      <option key={tag.id} value={tag.id}>{tag.name}</option>
                    ))}
                </select>
              </div>
            </motion.aside>
          ) : null}
        </AnimatePresence>
      </div>

      {fullscreenActive ? null : (
        <div className="pointer-events-none absolute bottom-3 left-0 right-0 z-10 flex items-center justify-center gap-3 text-[11.5px] text-white/45">
          <span className="tabular-nums">
            {counter} / {items.length}
          </span>
          {asset.width && asset.height ? (
            <span className="tabular-nums">
              {asset.width} × {asset.height}
            </span>
          ) : null}
        </div>
      )}
    </>
  )
}
