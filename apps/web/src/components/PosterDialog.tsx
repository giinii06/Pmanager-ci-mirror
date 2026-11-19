import { useEffect, useState, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, RotateCcw } from 'lucide-react'
import type { AssetDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { patchAssetInCaches } from '../lib/cachePatch'
import { formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Spinner } from './ui/Spinner'

const STEP_MS = 10_000

/** A frame at the exact end of the file does not exist; stop half a second short. */
const END_MARGIN_MS = 500

function clock(ms: number): string {
  return formatDuration(ms) || '0:00'
}

function durationOf(assetDurationMs: number | null, element: HTMLVideoElement | null): number {
  const fromElement = element && Number.isFinite(element.duration) ? element.duration * 1000 : 0
  if (fromElement > 0) return Math.round(fromElement)
  return assetDurationMs && assetDurationMs > 0 ? assetDurationMs : 0
}

export function PosterDialog({
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
  const [durationMs, setDurationMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const maxPosition = durationMs > 0 ? Math.max(0, durationMs - END_MARGIN_MS) : 0

  useEffect(() => {
    if (!open) return
    const element = videoRef.current
    element?.pause()
    const total = durationOf(asset.durationMs, element)
    const current =
      element && Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) : 0
    setPositionMs(Math.max(0, Math.min(total > 0 ? total - END_MARGIN_MS : 0, current)))
    setDurationMs(total)
    setError(null)
  }, [open, asset.id, asset.durationMs, videoRef])

  const seek = (ms: number) => {
    const element = videoRef.current
    const next = durationMs > 0 ? Math.max(0, Math.min(maxPosition, Math.round(ms))) : 0
    setPositionMs(next)
    if (!element) return
    element.currentTime = next / 1000
  }

  const capture = useMutation({
    mutationFn: () => api.captureThumbnail(asset.id, positionMs),
    onSuccess: ({ asset: updated }) => {
      patchAssetInCaches(queryClient, updated)
      queryClient.invalidateQueries({ queryKey: ['tags'] })
      toast(`${clock(positionMs)} 프레임을 포스터로 저장했습니다.`, 'success')
      onClose()
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : '포스터를 저장하지 못했습니다.'
      setError(message)
    },
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="포스터 선택"
      description={`${asset.filename} · 이전 포스터는 저장이 끝날 때까지 그대로 유지됩니다.`}
      className="w-[min(600px,94vw)]"
      footer={
        <>
          <Button onClick={onClose} disabled={capture.isPending}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={capture.isPending || durationMs <= 0}
            onClick={() => {
              setError(null)
              capture.mutate()
            }}
          >
            {capture.isPending ? <Spinner className="size-3.5" /> : <Camera size={14} />}
            {capture.isPending ? '저장 중' : '이 지점을 포스터로'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-panel-2/60 p-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] text-muted">선택한 지점</span>
            <span className="text-[20px] font-semibold tabular-nums text-ink">
              {clock(positionMs)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(maxPosition, 1)}
            step={100}
            value={Math.min(positionMs, Math.max(maxPosition, 0))}
            disabled={capture.isPending || durationMs <= 0}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="포스터로 사용할 지점"
            className="mt-3 w-full accent-[var(--color-accent)]"
          />
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-faint">
            <span>0:00</span>
            <span>{clock(durationMs)}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={capture.isPending || durationMs <= 0}
              onClick={() => seek(positionMs - STEP_MS)}
            >
              -10초
            </Button>
            <Button
              size="sm"
              disabled={capture.isPending || durationMs <= 0}
              onClick={() => seek(positionMs + STEP_MS)}
            >
              +10초
            </Button>
            <Button
              size="sm"
              disabled={capture.isPending || durationMs <= 0}
              onClick={() => {
                const element = videoRef.current
                if (!element || !Number.isFinite(element.currentTime)) return
                seek(element.currentTime * 1000)
              }}
            >
              <RotateCcw size={12} />
              재생 위치
            </Button>
          </div>
        </div>

        <p className="text-[12px] leading-relaxed text-faint">
          플레이어가 선택한 지점으로 이동합니다. 원하는 장면에서 저장하면 그 프레임이 모든
          썸네일 크기의 포스터로 게시됩니다. 원본 영상은 바뀌지 않습니다.
        </p>

        {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        {capture.isPending ? (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Spinner className="size-3.5" />
            프레임을 추출해 포스터를 게시하는 중
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
