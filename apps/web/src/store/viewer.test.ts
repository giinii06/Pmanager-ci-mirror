import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AssetDTO } from '@mediavault/shared'
import { useViewer } from './viewer'

const originalFetch = globalThis.fetch
let pending: Array<{ url: string; resolve: (body: unknown) => void }> = []

function asset(id: string): AssetDTO {
  return {
    id,
    libraryId: 'lib1',
    folderId: 'folder0001',
    filename: `${id}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1000,
    width: 160,
    height: 120,
    durationMs: 120_000,
    takenAt: 1000,
    fileVersion: 1,
    viewCount: 0,
    watchTimeMs: 0,
    voteCount: 0,
    rate: null,
    tags: [],
  } as unknown as AssetDTO
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  pending = []
  useViewer.setState({
    items: [],
    index: 0,
    startMs: null,
    shuffle: false,
    filter: null,
    sessionId: 0,
    navigationRequestId: 0,
    recentIds: [],
    loadingNext: false,
  })
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    return new Promise((resolve, reject) => {
      pending.push({
        url,
        resolve: (body) =>
          resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      })
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  useViewer.getState().close()
})

describe('viewer navigation', () => {
  test('fetches the next asset from the server at the end of the loaded list', async () => {
    useViewer.getState().open([asset('a'), asset('b')], 1, { filter: { kind: 'video' } })
    useViewer.getState().next()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.url).toContain('/api/assets/b/neighbor')
    expect(pending[0]!.url).toContain('direction=next')
    expect(pending[0]!.url).toContain('kind=video')

    pending[0]!.resolve({ asset: asset('c') })
    await flush()

    const state = useViewer.getState()
    expect(state.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(state.index).toBe(2)
    expect(state.loadingNext).toBe(false)
  })

  test('a response for an older request cannot replace a newer selection', async () => {
    useViewer.getState().open([asset('a')], 0, { filter: { kind: 'video' } })
    useViewer.getState().next()
    useViewer.getState().select(asset('z'))
    pending[0]!.resolve({ asset: asset('b') })
    await flush()

    const state = useViewer.getState()
    expect(state.items.map((item) => item.id)).toEqual(['z'])
    expect(state.index).toBe(0)
  })

  test('closing the viewer discards an in-flight response', async () => {
    useViewer.getState().open([asset('a')], 0, { filter: { kind: 'video' } })
    useViewer.getState().next()
    useViewer.getState().close()
    pending[0]!.resolve({ asset: asset('b') })
    await flush()

    expect(useViewer.getState().items).toEqual([])
  })

  test('shuffle asks the server and appends the picked asset', async () => {
    useViewer.getState().open([asset('a')], 0, { filter: { kind: 'video', sort: 'rate', seed: 9 } })
    useViewer.getState().toggleShuffle()
    useViewer.getState().next()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.url).toBe('/api/assets/random')

    pending[0]!.resolve({ asset: asset('c') })
    await flush()

    const state = useViewer.getState()
    expect(state.items.map((item) => item.id)).toEqual(['a', 'c'])
    expect(state.index).toBe(1)
    expect(state.recentIds).toEqual(['a', 'c'])
  })

  test('a single shared-link asset has no server scope', () => {
    useViewer.getState().open([asset('a')], 0)
    useViewer.getState().next()
    useViewer.getState().toggleShuffle()
    useViewer.getState().next()
    expect(pending).toHaveLength(0)
    expect(useViewer.getState().index).toBe(0)
  })
})
