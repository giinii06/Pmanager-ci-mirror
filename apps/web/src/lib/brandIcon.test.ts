import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('Pmanager brand icon', () => {
  test('ships a 192px PNG from the Vite public root', () => {
    const png = readFileSync(new URL('../../public/brand-icon.png', import.meta.url))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png.readUInt32BE(16)).toBe(192)
    expect(png.readUInt32BE(20)).toBe(192)
  })

  test('declares browser favicon and touch icon with a cache-busting URL', () => {
    const html = source('../../index.html')
    expect(html).toContain('rel="icon" type="image/png" sizes="192x192" href="/brand-icon.png?v=1"')
    expect(html).toContain('rel="apple-touch-icon" href="/brand-icon.png?v=1"')
  })

  test('reuses the brand mark for sidebar, sign-in and loading states', () => {
    expect(source('../components/BrandMark.tsx')).toContain("'/brand-icon.png?v=1'")
    expect(source('../components/Sidebar.tsx')).toContain('<BrandMark size={44} />')
    expect(source('../pages/AuthPages.tsx')).toContain('<BrandMark size={44} />')
    expect(source('../App.tsx')).toContain('<BrandMark size={36} />')
  })
})
