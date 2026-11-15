import { useEffect, useRef, useState } from 'react'
import { MAX_THUMBNAIL_RETRIES } from '@mediavault/shared'
import { cn } from '../lib/cn'

interface ThumbProps {
  src: string
  srcSet?: string
  sizes?: string
  alt: string
  className?: string
  imageClassName?: string
  onLoaded?: () => void
}

function retryUrl(url: string, attempt: number): string {
  if (attempt === 0) return url
  return `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`
}

export function Thumb({ src, srcSet, sizes, alt, className, imageClassName, onLoaded }: ThumbProps) {
  const [attempt, setAttempt] = useState(0)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  const current = retryUrl(src, attempt)
  const loaded = loadedSrc === current

  useEffect(() => {
    setAttempt(0)
  }, [src])

  useEffect(() => {
    const image = imageRef.current
    if (image?.complete && image.naturalWidth > 0 && image.currentSrc === current) {
      setLoadedSrc(current)
    }
  }, [current])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const withRetrySrcSet = (value: string) =>
    value
      .split(',')
      .map((candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/)
        if (!url) return candidate
        return [retryUrl(url, attempt), ...descriptor].join(' ')
      })
      .join(', ')

  return (
    <div className={cn('relative overflow-hidden bg-raised', className)}>
      {!loaded ? <div className="absolute inset-0 animate-pulse bg-raised" /> : null}
      <img
        ref={imageRef}
        src={current}
        srcSet={srcSet ? withRetrySrcSet(srcSet) : undefined}
        sizes={sizes}
        alt={alt}
        draggable={false}
        loading="lazy"
        decoding="async"
        className={cn(
          'h-full w-full object-cover transition-opacity duration-300',
          loaded ? 'opacity-100' : 'opacity-0',
          imageClassName,
        )}
        onLoad={() => {
          setLoadedSrc(current)
          onLoaded?.()
        }}
        onError={() => {
          if (attempt >= MAX_THUMBNAIL_RETRIES) return
          timer.current = window.setTimeout(() => setAttempt((value) => value + 1), 1200)
        }}
      />
    </div>
  )
}
