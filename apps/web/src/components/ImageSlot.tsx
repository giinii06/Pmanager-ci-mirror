import { useEffect, useRef, useState } from 'react'
import type { AssetDTO } from '@mediavault/shared'
import { cn } from '../lib/cn'

/**
 * Paints only once its bitmap is decoded, so a layer never swaps in
 * half-decoded and never fades from transparent over a blank box.
 */
function DecodedImage({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
}) {
  const [readySrc, setReadySrc] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const ready = readySrc === src

  useEffect(() => {
    const image = imageRef.current
    if (!image) return

    let cancelled = false
    const done = () => {
      if (!cancelled) setReadySrc(src)
    }

    if (image.complete && image.naturalWidth > 0 && image.getAttribute('src') === src) {
      done()
      return
    }

    if (typeof image.decode === 'function') {
      // decode() resolves only when the bitmap can be painted; a rejected
      // decode still lets the load event finish the job.
      image.decode().then(done, () => {
        if (image.complete && image.naturalWidth > 0) done()
        else image.addEventListener('load', done, { once: true })
      })
    } else {
      image.addEventListener('load', done, { once: true })
    }

    return () => {
      cancelled = true
      image.removeEventListener('load', done)
    }
  }, [src])

  return (
    <img
      ref={imageRef}
      src={src}
      alt={alt}
      draggable={false}
      onLoad={() => setReadySrc(src)}
      className={cn(
        'absolute inset-0 h-full w-full object-contain transition-opacity duration-150',
        ready ? 'opacity-100' : 'opacity-0',
        className,
      )}
    />
  )
}

interface ImageSlotProps {
  asset: AssetDTO
  width: number
  height: number
  /** The original file instead of the 1600px preview. */
  full: boolean
  selected?: boolean
  onSelect?: () => void
}

/**
 * Three stacked layers: the 320px thumbnail the gallery already has cached, a
 * 640px pass that arrives almost as fast, and the decoded preview on top.
 * The gallery's own bitmap is visible from the first frame, so opening never
 * flashes a spinner or an empty box.
 */
export function ImageSlot({ asset, width, height, full, selected, onSelect }: ImageSlotProps) {
  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden rounded-[6px] bg-black/20 shadow-[0_20px_80px_rgba(0,0,0,0.65)]',
        selected && 'ring-1 ring-accent/80',
        onSelect && 'cursor-pointer',
      )}
      style={{ width, height }}
      onClick={onSelect}
    >
      <img
        src={asset.thumbnails.small}
        alt=""
        aria-hidden
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
      />
      <DecodedImage src={asset.thumbnails.medium} alt="" />
      <DecodedImage src={asset.previewUrl} alt={asset.filename} />
      {full ? <DecodedImage src={asset.streamUrl} alt="" /> : null}
    </div>
  )
}
