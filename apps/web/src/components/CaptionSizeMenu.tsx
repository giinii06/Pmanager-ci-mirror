import { useEffect, useRef, useState } from 'react'
import { Type } from 'lucide-react'
import { cn } from '../lib/cn'

export const CAPTION_SCALE_KEY = 'mediavault.caption-scale'
export const CAPTION_SCALE_MIN = 0.6
export const CAPTION_SCALE_MAX = 2

/** The saved size, or 1 when nothing valid is stored. */
export function storedCaptionScale(): number {
  try {
    const value = Number(localStorage.getItem(CAPTION_SCALE_KEY))
    if (Number.isFinite(value) && value >= CAPTION_SCALE_MIN && value <= CAPTION_SCALE_MAX) {
      return value
    }
  } catch {
    // Storage can be blocked; the default size still works.
  }
  return 1
}

export function CaptionSizeMenu({
  scale,
  onChange,
}: {
  scale: number
  onChange: (scale: number) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const percent = Math.round(scale * 100)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Capture phase, so the lightbox does not also close on the same Escape.
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`자막 크기 ${percent}%`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11.5px] backdrop-blur-sm transition-colors',
          open
            ? 'bg-black/80 text-white'
            : 'bg-black/55 text-white/85 hover:bg-black/75 hover:text-white',
        )}
      >
        <Type size={13} />
        <span>{percent}%</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="자막 크기"
          className="absolute right-0 top-full mt-1.5 w-[204px] rounded-lg border border-white/10 bg-[#0b0c0f]/97 px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[11.5px] text-muted">자막 크기</span>
            <span className="text-[11.5px] text-ink">{percent}%</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              aria-label="자막 작게"
              onClick={() => onChange(scale - 0.1)}
              className="rounded px-1 text-[13px] text-white/75 transition-colors hover:text-white"
            >
              A−
            </button>
            <input
              type="range"
              aria-label="자막 크기"
              min={CAPTION_SCALE_MIN * 100}
              max={CAPTION_SCALE_MAX * 100}
              step={5}
              value={percent}
              onChange={(event) => onChange(Number(event.target.value) / 100)}
              className="h-1 min-w-0 flex-1 accent-accent"
            />
            <button
              type="button"
              aria-label="자막 크게"
              onClick={() => onChange(scale + 0.1)}
              className="rounded px-1 text-[15px] text-white/75 transition-colors hover:text-white"
            >
              A+
            </button>
          </div>
          <button
            type="button"
            onClick={() => onChange(1)}
            disabled={percent === 100}
            className="mt-2 w-full rounded border border-white/10 px-2 py-1 text-[11.5px] text-white/75 transition-colors hover:bg-white/8 hover:text-white disabled:invisible"
          >
            기본 크기
          </button>
        </div>
      ) : null}
    </div>
  )
}
