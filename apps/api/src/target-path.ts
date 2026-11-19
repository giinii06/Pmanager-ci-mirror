/** Empty means the library root; anything with a `..` or a backslash is refused. */
export function normalizeTargetFolder(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (value === '') return ''
  if (value.includes('\\') || value.includes('\0')) return null
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  return segments.join('/')
}

export function joinTargetPath(folder: string, filename: string): string {
  return folder === '' ? filename : `${folder}/${filename}`
}
