import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface SendFileOptions {
  cacheControl?: string
  accelPath?: string
  contentDisposition?: string
}

export function accelPathFor(prefix: '/internal/media' | '/internal/cache', relative: string): string {
  const encoded = relative
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `${prefix}/${encoded}`
}

interface ByteRange {
  start: number
  end: number
}

function parseRange(header: string, size: number): ByteRange | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (startRaw === '' && endRaw === '') return 'invalid'

  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startRaw)
  const end = endRaw === '' ? size - 1 : Number(endRaw)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Bun's Fastify build does not stream a payload passed to reply.send. This
 * writes through the raw response instead, which keeps Content-Length and
 * byte ranges intact.
 */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  absolutePath: string,
  contentType: string,
  options: SendFileOptions = {},
): Promise<void> {
  if (options.accelPath) {
    reply.header('X-Accel-Redirect', options.accelPath)
    reply.header('Content-Type', contentType)
    reply.header('Accept-Ranges', 'bytes')
    if (options.cacheControl) reply.header('Cache-Control', options.cacheControl)
    if (options.contentDisposition) {
      reply.header('Content-Disposition', options.contentDisposition)
    }
    reply.send('')
    return
  }

  let size: number
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch {
    reply.code(404).send({ error: 'not_found', message: 'File not found.' })
    return
  }

  let status = 200
  let start = 0
  let end = Math.max(0, size - 1)
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
  }
  if (options.cacheControl) headers['cache-control'] = options.cacheControl
  if (options.contentDisposition) headers['content-disposition'] = options.contentDisposition

  const rangeHeader = request.headers.range
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size)
    if (range === 'invalid') {
      reply.code(416).header('Content-Range', `bytes */${size}`).send()
      return
    }
    if (range) {
      status = 206
      start = range.start
      end = range.end
      headers['content-range'] = `bytes ${start}-${end}/${size}`
    }
  }
  headers['content-length'] = size === 0 ? 0 : end - start + 1

  reply.hijack()
  reply.raw.writeHead(status, headers)
  if (request.method === 'HEAD' || size === 0) {
    reply.raw.end()
    return
  }

  const stream = createReadStream(absolutePath, { start, end })
  stream.on('error', (error) => {
    reply.raw.destroy(error)
  })
  stream.pipe(reply.raw)
}
