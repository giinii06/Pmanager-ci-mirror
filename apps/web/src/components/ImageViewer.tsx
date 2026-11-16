import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AssetDTO } from '@mediavault/shared'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Heart,
  Info,
  Maximize2,
  Minimize2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { cn } from '../lib/cn'
import { formatBytes, formatDate } from '../lib/format'
import { useMeasuredElement } from '../lib/hooks'
import { fitPage, groupViewerItems, pageAt, VIEWER_GAP } from '../lib/viewerPages'
import { ImageSlot } from './ImageSlot'
import { useImageFullscreen } from './useImageFullscreen'
import { IconButton } from './ui/IconButton'

interface FavoriteMutation {
  mutate: (variables: { id: string; favorite: boolean }) => void
}

/** A keypress right after leaving fullscreen must not also close the viewer. */
const FULLSCREEN_EXIT_GRACE_MS = 350

export function ImageViewer({
  asset,
  items,
  index,
  libraryName,
  favorite,
  closeRef,
  onClose,
  onSelect,
}: {
  asset: AssetDTO
  items: AssetDTO[]
  index: number
  libraryName?: string
  favorite: FavoriteMutation
  closeRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSelect: (asset: AssetDTO) => void
}) {
  const [showInfo, setShowInfo] = useState(false)
  const [fullRes, setFullRes] = useState(false)
  const stage = useMeasuredElement<HTMLDivElement>()
  const { mode, active: fullscreenActive, toggle: toggleFullscreen, exit: exitFullscreen } =
    useImageFullscreen(stage.ref)
  const exitedAt = useRef(0)
  const wasFullscreen = useRef(false)

  const room = useMemo(
    () => ({ width: stage.width, height: stage.height }),
    [stage.width, stage.height],
  )
  const pages = useMemo(() => groupViewerItems(items, room), [items, room])
  const pageIndex = pageAt(pages, index)
  const page = pages[pageIndex] ?? { start: index, end: index + 1 }
  const pageItems = items.slice(page.start, page.end)
  const sizes = useMemo(() => fitPage(items, page, room), [items, page, room])

  useEffect(() => {
    setShowInfo(false)
    setFullRes(false)
  }, [asset.id])

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
        // The keypress that leaves fullscreen must not close the viewer, even
        // when the browser reports the exit before delivering the key.
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

      const key = event.key.toLowerCase()
      if (key === 'f') favorite.mutate({ id: asset.id, favorite: !asset.favorite })
      else if (key === 'i') setShowInfo((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asset, exitFullscreen, favorite, fullscreenActive, goNext, goPrev, onClose])

  // Prefetch whole neighbouring pages, previews only: the original file is
  // large and only loaded when it is actually shown.
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
        <div className="relative z-20 flex items-center justify-between gap-4 bg-gradient-to-b from-black/70 to-transparent px-3 py-2.5 sm:px-5">
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
              <p className="truncate text-[13px] font-medium text-white">{asset.filename}</p>
              <p className="truncate text-[11.5px] text-white/45">{formatDate(asset.takenAt)}</p>
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            <IconButton
              label={asset.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
              active={asset.favorite}
              onClick={() => favorite.mutate({ id: asset.id, favorite: !asset.favorite })}
            >
              <Heart size={17} fill={asset.favorite ? 'currentColor' : 'none'} />
            </IconButton>
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
              label="정보"
              active={showInfo}
              onClick={() => setShowInfo((value) => !value)}
            >
              <Info size={17} />
            </IconButton>
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
              className="w-[300px] max-w-[86vw] shrink-0 overflow-y-auto border-l border-white/10 bg-[#0b0c0f]/97 px-5 py-6"
            >
              <h3 className="text-[13px] font-semibold text-ink">정보</h3>
              <dl className="mt-4 space-y-3.5 text-[12.5px]">
                <div>
                  <dt className="text-faint">파일 이름</dt>
                  <dd className="mt-0.5 break-all text-ink">{asset.filename}</dd>
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
