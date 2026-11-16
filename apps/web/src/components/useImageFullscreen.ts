import { useCallback, useEffect, useState, type RefObject } from 'react'

/**
 * `native` is the Fullscreen API, `pseudo` the CSS fallback for browsers that
 * refuse it. Both hide the viewer chrome; only `native` leaves the document.
 */
export type ImageFullscreen = 'none' | 'native' | 'pseudo'

function currentFullscreenElement(): Element | null {
  return (
    document.fullscreenElement ??
    (document as Document & { webkitFullscreenElement?: Element | null })
      .webkitFullscreenElement ??
    null
  )
}

export function useImageFullscreen(containerRef: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState<ImageFullscreen>('none')

  useEffect(() => {
    const sync = () => {
      const native = currentFullscreenElement() === containerRef.current
      setMode((current) => {
        if (native) return 'native'
        // Any other element taking fullscreen (a video, another lightbox)
        // means ours ended.
        return current === 'native' ? 'none' : current
      })
    }

    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [containerRef])

  const exit = useCallback(() => {
    if (currentFullscreenElement()) {
      void document.exitFullscreen?.().catch(() => undefined)
      return
    }
    setMode('none')
  }, [])

  const enter = useCallback(() => {
    const element = containerRef.current
    if (!element || typeof element.requestFullscreen !== 'function') {
      setMode('pseudo')
      return
    }
    element.requestFullscreen().catch(() => setMode('pseudo'))
  }, [containerRef])

  const toggle = useCallback(() => {
    if (mode === 'none') enter()
    else exit()
  }, [enter, exit, mode])

  return { mode, active: mode !== 'none', toggle, exit }
}
