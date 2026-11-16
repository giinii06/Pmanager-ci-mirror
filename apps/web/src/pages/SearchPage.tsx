import { useQuery } from '@tanstack/react-query'
import { Images, Play, ScanSearch, Volume2 } from 'lucide-react'
import { POSTER_SCHEME, type SemanticHitDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatDuration } from '../lib/format'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Spinner } from '../components/ui/Spinner'

const SOURCE_LABEL: Record<SemanticHitDTO['source'], string> = {
  visual: '화면',
  audio: '소리',
  av: '화면+소리',
  dialogue: '대사',
  title: '파일명',
}

function sourceClass(source: SemanticHitDTO['source']): string {
  if (source === 'dialogue') return 'bg-[#60a5fa]/15 text-[#93c5fd]'
  if (source === 'title') return 'bg-white/[0.07] text-muted'
  return 'bg-accent/15 text-accent'
}

function timeLabel(hit: SemanticHitDTO): string {
  if (hit.startMs === null) return formatDuration(hit.asset.durationMs)
  return formatDuration(hit.startMs)
}

function thumbnailFor(hit: SemanticHitDTO): string {
  return hit.thumbnailUrl ?? `/api/assets/${hit.assetId}/thumbnail?p=${POSTER_SCHEME}`
}

/** Why this row matched, when the row has no dialogue line to quote. */
function subtitleFor(hit: SemanticHitDTO): string {
  if (hit.kind === 'dialogue') return hit.text
  if (hit.source === 'title') return '파일 이름이 일치합니다'
  if (hit.source === 'audio') return '소리가 비슷한 구간'
  if (hit.source === 'av') return '화면과 소리가 비슷한 구간'
  return '화면이 비슷한 구간'
}

export function SearchPage({ query }: { query: string }) {
  const toast = useUi((state) => state.toast)
  const openViewer = useViewer((state) => state.open)

  const results = useQuery({
    queryKey: ['semantic', query],
    queryFn: () => api.semanticSearch(query),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
  })

  if (!query.trim()) {
    return (
      <div className="px-6 pb-24">
        <PageHeading title="검색" />
        <EmptyState
          title="검색어를 입력하세요"
          body="장면, 대사, 파일 이름을 한 번에 찾습니다. “바다에서 운전하는 장면”처럼 적어도 됩니다."
          icon={<Images size={20} />}
        />
      </div>
    )
  }

  const open = async (hit: SemanticHitDTO) => {
    try {
      const asset = await api.asset(hit.assetId)
      openViewer([asset], 0, hit.startMs)
    } catch (error) {
      toast(error instanceof Error ? error.message : '파일을 열 수 없습니다', 'error')
    }
  }

  return (
    <div className="px-6 pb-24">
      <PageHeading title={`검색: ${query}`} />
      {results.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : results.isError ? (
        <EmptyState
          title="검색하지 못했습니다"
          body="잠시 뒤 다시 시도해 주세요."
          icon={<Images size={20} />}
        />
      ) : results.data.hits.length === 0 ? (
        <EmptyState
          title="검색 결과가 없습니다"
          body="장면은 아직 색인되지 않았을 수 있습니다. 다른 낱말로도 찾아보세요."
          icon={<Images size={20} />}
        />
      ) : (
        <>
          <p className="mb-3 flex items-center gap-1.5 text-[12px] text-faint">
            <ScanSearch size={13} />
            {results.data.scenesSearched
              ? '장면·대사·파일 이름을 함께 찾았습니다.'
              : '장면 검색을 쓸 수 없어 대사와 파일 이름만 찾았습니다.'}
          </p>
          <ul className="space-y-1.5">
            {results.data.hits.map((hit) => (
              <li key={`${hit.kind}:${hit.sceneId ?? hit.assetId}:${hit.startMs ?? 0}:${hit.text.slice(0, 16)}`}>
                <button
                  type="button"
                  onClick={() => open(hit)}
                  className="group flex w-full items-center gap-3 rounded-xl border border-line/70 bg-panel/60 p-2 text-left transition-colors hover:border-line hover:bg-raised/70"
                >
                  <span className="relative h-[54px] w-[96px] shrink-0 overflow-hidden rounded-lg bg-raised">
                    <img
                      src={thumbnailFor(hit)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
                      <Play size={16} fill="white" className="text-white" />
                    </span>
                    {hit.startMs !== null ? (
                      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white/90">
                        {timeLabel(hit)}
                      </span>
                    ) : null}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {hit.asset.filename}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium',
                          sourceClass(hit.source),
                        )}
                      >
                        {SOURCE_LABEL[hit.source]}
                      </span>
                      {hit.source === 'audio' ? (
                        <Volume2 size={12} className="shrink-0 text-faint" />
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-muted">
                      {subtitleFor(hit)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
