import { describe, expect, test } from 'bun:test'
import { classifyFile, extensionOf, playbackModeFor } from './media'

describe('classifyFile', () => {
  test('maps image extensions case-insensitively', () => {
    expect(classifyFile('IMG_0001.JPG')).toEqual({ kind: 'image', mimeType: 'image/jpeg' })
    expect(classifyFile('cover.webp')).toEqual({ kind: 'image', mimeType: 'image/webp' })
    expect(classifyFile('scan.HEIC')).toEqual({ kind: 'image', mimeType: 'image/heic' })
  })

  test('maps video extensions', () => {
    expect(classifyFile('clip.mp4')).toEqual({ kind: 'video', mimeType: 'video/mp4' })
    expect(classifyFile('old.mkv')).toEqual({ kind: 'video', mimeType: 'video/x-matroska' })
  })

  test('rejects unknown and hidden files', () => {
    expect(classifyFile('notes.txt')).toBeNull()
    expect(classifyFile('.DS_Store')).toBeNull()
    expect(classifyFile('noextension')).toBeNull()
  })

  test('extensionOf handles dots in directories', () => {
    expect(extensionOf('a.b/c.jpg')).toBe('jpg')
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('playbackModeFor', () => {
  const base = { kind: 'video' as const, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }

  test('plays h264/aac mp4 directly', () => {
    expect(playbackModeFor(base)).toBe('direct')
    expect(playbackModeFor({ ...base, container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' })).toBe(
      'direct',
    )
  })

  test('transcodes HEVC, MKV and unknown codecs', () => {
    expect(playbackModeFor({ ...base, videoCodec: 'hevc' })).toBe('hls')
    expect(playbackModeFor({ ...base, container: 'mkv' })).toBe('hls')
    expect(playbackModeFor({ ...base, videoCodec: null })).toBe('hls')
    expect(playbackModeFor({ ...base, audioCodec: 'ac3' })).toBe('hls')
  })

  test('images have no playback mode', () => {
    expect(playbackModeFor({ ...base, kind: 'image' })).toBe('none')
  })
})
