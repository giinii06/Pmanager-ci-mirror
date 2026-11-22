import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './Button'
import { Input } from './Input'
import { Section, MetricPill } from './Section'
import { PageHeading } from '../PageHeading'
import { EmptyState } from '../EmptyState'

describe('workspace visual system', () => {
  test('actions and fields use the larger rounded controls while retaining disabled semantics', () => {
    const markup = renderToStaticMarkup(
      <div>
        <Button variant="primary" disabled>새 페이지</Button>
        <Input aria-label="검색" placeholder="미디어 검색" />
      </div>,
    )
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('min-h-11')
    expect(markup).toContain('rounded-xl')
    expect(markup).toContain('aria-label="검색"')
  })

  test('sections, metrics, headings and empty states share legible type and generous surfaces', () => {
    const markup = renderToStaticMarkup(
      <div>
        <PageHeading title="사진" meta="100개" />
        <Section title="처리 현황" description="대기 중인 작업">
          <MetricPill label="작업" value="0" />
        </Section>
        <EmptyState title="사진이 없습니다" body="라이브러리를 등록하세요." />
      </div>,
    )
    expect(markup).toContain('사진')
    expect(markup).toContain('rounded-panel')
    expect(markup).toContain('text-[16px]')
    expect(markup).toContain('사진이 없습니다')
  })

  test('original theme palettes and media contain rendering remain untouched', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
    for (const color of ['#fbfbfb', '#2e2e34', '#1a1a1e', '#070709']) {
      expect(styles).toContain('--color-canvas: ' + color)
    }
    expect(styles).toContain('--radius-tile: 14px')
    expect(styles).toContain('--radius-panel: 22px')
    const tile = readFileSync(new URL('../AssetTile.tsx', import.meta.url), 'utf8')
    const folder = readFileSync(new URL('../FolderCard.tsx', import.meta.url), 'utf8')
    const search = readFileSync(new URL('../../pages/SearchPage.tsx', import.meta.url), 'utf8')
    const duplicates = readFileSync(new URL('../../pages/DuplicatesPage.tsx', import.meta.url), 'utf8')
    expect(tile).toContain('fit="contain"')
    expect(folder).toContain('fit="contain"')
    expect(search).toContain('<AssetGallery')
    expect(duplicates).toContain('object-contain')
  })
})
