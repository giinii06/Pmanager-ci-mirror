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

  test('in-browser fill is owned by the viewer and forwarded across keyed video changes', () => {
    const store = file('../store/viewer.ts')
    const overlay = file('./Lightbox.tsx')
    const watch = file('./WatchPage.tsx')
    const player = file('./VideoPlayer.tsx')
    expect(store).toContain('browserFill: boolean')
    expect(store).toContain('setBrowserFill: (enabled: boolean) => void')
    expect(overlay).toContain('browserFill={browserFill}')
    expect(overlay).toContain('onBrowserFillChange={setBrowserFill}')
    expect(watch).toContain('key={asset.id}')
    expect(watch).toContain('onPrev={onPrev}')
    expect(watch).toContain('onNext={onNext}')
    expect(player).not.toContain('const [browserFill, setBrowserFill]')
    expect(player).toContain('onClick={onPrev}')
    expect(player).toContain('onClick={onNext}')
    expect(player).toContain('이전 동영상')
    expect(player).toContain('다음 동영상')
  })

  test('next clip requests automatic playback including HLS-ready streams', () => {
    const player = file('./VideoPlayer.tsx')
    expect(player).toContain('autoPlay')
    expect(player).toContain('video.addEventListener(\'canplay\', start)')
    expect(player).toContain('video.play().catch(() => undefined)')
    expect(player).toContain('asset.id, videoRef, useHls, playlistUrl')
    expect(player).toContain('hls.attachMedia(video)')
  })

  test('photo and video galleries default to random order', () => {
    const photos = file('../pages/FolderPages.tsx')
    const videos = file('../pages/GalleryPages.tsx')
    expect(photos).toContain("useState<FolderSort>('random')")
    expect((videos.match(/useState<VideoSort>\('random'\)/g) ?? []).length).toBe(2)
  })
  test('global search uses the paginated filename gallery and no semantic results', () => {
    const search = file('../pages/SearchPage.tsx')
    const topbar = file('./Topbar.tsx')
    expect(search).toContain('<AssetGallery')
    expect(search).toContain('showFilenames')
    expect(search).toContain("filters={{ q: name, sort: 'latest' }}")
    expect(search).not.toContain('semanticSearch')
    expect(search).not.toContain('SemanticHitDTO')
    expect(topbar).toContain('placeholder="파일 이름으로 검색"')
    expect(topbar).toContain('if (trimmed.length >= 1)')
  })

})
