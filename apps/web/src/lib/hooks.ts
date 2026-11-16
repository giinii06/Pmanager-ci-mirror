import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * A callback ref, because the measured element often mounts after the first
 * render (for example once the first page of assets arrives).
 */
export function useElementWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number,
] {
  const [node, setNode] = useState<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(node)
    setWidth(Math.floor(node.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [node])

  return [setNode, width]
}

/**
 * Measures an element that mounts conditionally and also exposes it as a ref,
 * for APIs such as the Fullscreen one that need the node outside an effect.
 */
export function useMeasuredElement<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  attach: (node: T | null) => void
  width: number
  height: number
} {
  const ref = useRef<T | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const attach = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    ref.current = node
    if (!node) {
      setSize({ width: 0, height: 0 })
      return
    }

    const measure = () => {
      const rect = node.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      )
    }

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    observerRef.current = observer
    measure()
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return { ref, attach, width: size.width, height: size.height }
}
