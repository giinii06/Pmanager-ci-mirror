import type { SceneQueryVectors } from '@mediavault/database'

/**
 * The query tower runs as its own CPU service, so a search never waits for the
 * card and never loads a model in this process. A failure here is not fatal:
 * the caller falls back to the dialogue and filename legs.
 */
export async function encodeSceneQuery(
  baseUrl: string,
  text: string,
  dimensions: number,
  timeoutMs = 8_000,
): Promise<SceneQueryVectors | null> {
  try {
    const response = await fetch(`${baseUrl}/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      visual?: string
      audio?: string
      av?: string
      dimensions?: number
    }
    if (payload.dimensions !== dimensions) return null
    const visual = decode(payload.visual, dimensions)
    const audio = decode(payload.audio, dimensions)
    const av = decode(payload.av, dimensions)
    if (!visual || !audio || !av) return null
    return { visual, audio, av }
  } catch {
    return null
  }
}

function decode(encoded: string | undefined, dimensions: number): Float32Array | null {
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== dimensions * 4) return null
  const vector = new Float32Array(new Uint8Array(bytes).buffer)
  let sum = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) return null
    sum += value * value
  }
  if (Math.abs(Math.sqrt(sum) - 1) > 1e-3) return null
  return vector
}
