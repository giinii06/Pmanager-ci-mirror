import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const file = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('clean workspace controls', () => {
  test('one collapse button and settings only in the sidebar', () => {
    const sidebar = file('./Sidebar.tsx')
    const topbar = file('./Topbar.tsx')
    expect(sidebar).not.toContain('PanelLeftClose')
    expect(sidebar).toContain('사이드바 펼치기')
    expect(topbar).not.toContain("navigate('/settings')")
    expect(sidebar).toContain('to="/settings"')
    expect(sidebar).not.toContain('to="/duplicates"')
  })

  test('video supports independent browser-fill and fullscreen actions', () => {
    const player = file('./VideoPlayer.tsx')
    expect(player).toContain('브라우저 화면 꽉 채우기')
    expect(player).toContain('aria-pressed={browserFill}')
    expect(player).toContain('onClick={toggleBrowserFill}')
    expect(player).toContain('onClick={toggleFullscreen}')
    expect(player).toContain("event.key !== 'Escape'")
    expect(player).toContain("fixed inset-0 z-[80] h-[100dvh] w-screen bg-black")
    expect(player).toContain("'h-full w-full object-contain'")
  })

  test('photo and video galleries default to newest order', () => {
    const photos = file('../pages/FolderPages.tsx')
    const videos = file('../pages/GalleryPages.tsx')
    expect(photos).toContain("useState<FolderSort>('date')")
    expect((videos.match(/useState<VideoSort>\('latest'\)/g) ?? []).length).toBe(2)
  })
})
