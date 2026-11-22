import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const webRoot = join(import.meta.dir, '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

describe('poda visual identity', () => {
  test('browser title and favicon point at the bundled logo', () => {
    const html = source('index.html')
    expect(html).toContain('<title>poda</title>')
    expect(html).toContain('href="/poda-icon.png"')
    expect(existsSync(join(webRoot, 'public/poda-icon.png'))).toBe(true)
  })

  test('logo is shown on all first-run and authenticated brand surfaces', () => {
    expect(source('src/App.tsx')).toContain('<BrandLogo')
    expect(source('src/pages/AuthPages.tsx')).toContain('<BrandLogo')
    expect(source('src/components/Sidebar.tsx')).toContain('<BrandLogo')
    expect(source('src/components/BrandLogo.tsx')).toContain('src="/poda-icon.png"')
  })

  test('legacy brand is not visible on primary screens', () => {
    for (const path of ['index.html', 'src/App.tsx', 'src/pages/AuthPages.tsx', 'src/components/Sidebar.tsx']) {
      expect(source(path)).not.toContain('MediaVault')
      expect(source(path)).toContain('poda')
    }
  })

  test('theme settings retain their existing storage key after the rebrand', () => {
    expect(source('index.html')).toContain("localStorage.getItem('mediavault.themeMode')")
  })
})
