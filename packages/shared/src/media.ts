import type { AssetKind, PlaybackMode } from './domain'

interface FileType {
  kind: AssetKind
  mimeType: string
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
}

const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return ''
  return filename.slice(dot + 1).toLowerCase()
}

export function classifyFile(filename: string): FileType | null {
  const ext = extensionOf(filename)
  const image = IMAGE_TYPES[ext]
  if (image) return { kind: 'image', mimeType: image }
  const video = VIDEO_TYPES[ext]
  if (video) return { kind: 'video', mimeType: video }
  return null
}

const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm'])
const DIRECT_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1'])
const DIRECT_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis'])

export interface CodecInfo {
  kind: AssetKind
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
}

/**
 * Chrome can play H.264/AAC in MP4 and VP9/Opus in WebM. Everything else,
 * including HEVC and Matroska, goes through the HLS transcode path.
 */
export function playbackModeFor(info: CodecInfo): PlaybackMode {
  if (info.kind !== 'video') return 'none'
  if (!info.videoCodec) return 'hls'
  const container = info.container?.toLowerCase() ?? ''
  if (!DIRECT_CONTAINERS.has(container)) return 'hls'
  if (!DIRECT_VIDEO_CODECS.has(info.videoCodec)) return 'hls'
  if (info.audioCodec && !DIRECT_AUDIO_CODECS.has(info.audioCodec)) return 'hls'
  return 'direct'
}

const BLOCKED_SYSTEM_SEGMENTS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'perflogs',
  'msocache',
  'config.msi',
  'boot',
  'documents and settings',
  'appdata',
  '$windows.~bt',
  '$windows.~ws',
])

export function isBlockedSystemRelativePath(relPosix: string): boolean {
  const segments = relPosix
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return segments.some((seg) => BLOCKED_SYSTEM_SEGMENTS.has(seg))
}

export function isMountBoundaryRoot(rootPath: string): boolean {
  const clean = rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return clean === '' || clean === 'extra' || clean === 'drives' || /^drives\/[a-z]$/i.test(clean)
}
