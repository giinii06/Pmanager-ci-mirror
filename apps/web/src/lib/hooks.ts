import { useEffect, useState } from 'react'

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
