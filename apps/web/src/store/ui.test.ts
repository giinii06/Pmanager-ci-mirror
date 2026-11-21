import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolveTheme, type ThemeMode } from './ui'

const modes: ThemeMode[] = ['light', 'ash', 'dark', 'onyx']

describe('appearance themes', () => {
  test('all four Discord-style presets resolve to the right browser color scheme', () => {
    expect(modes.map((mode) => resolveTheme(mode))).toEqual(['light', 'dark', 'dark', 'dark'])
  })

  test('the same palette selectors are used for both pages and previews', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    for (const mode of modes) {
      expect(css).toContain(`:root[data-theme='${mode}'],\n[data-theme-preview='${mode}']`)
    }
    expect(css).toContain('--color-canvas: #fbfbfb')
    expect(css).toContain('--color-canvas: #2e2e34')
    expect(css).toContain('--color-canvas: #1a1a1e')
    expect(css).toContain('--color-canvas: #070709')
  })
})
