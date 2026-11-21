import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Film, Folder as FolderIcon, Pencil, Plus, Tag, Trash2, X } from 'lucide-react'
import { POSTER_SCHEME, type VideoSort } from '@mediavault/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { useUi } from '../store/ui'
import { useViewer } from '../store/viewer'
import { AssetGallery } from '../components/AssetGallery'
import { EmptyState } from '../components/EmptyState'
import { PageHeading } from '../components/PageHeading'
import { Thumb } from '../components/Thumb'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { LoadingBlock } from '../components/ui/Spinner'

const SORT_OPTIONS: Array<{ value: VideoSort; label: string }> = [
  { value: 'rate', label: 'Rate순' },
  { value: 'views', label: '조회수순' },
  { value: 'latest', label: '최신순' },
  { value: 'name', label: '이름순' },
  { value: 'watch_time', label: '총 재생시간순' },
  { value: 'votes', label: 'Vote순' },
]

function SortBar({
  sort,
  onChange,
}: {
  sort: VideoSort
  onChange: (next: VideoSort) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="동영상 정렬">
      {SORT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={sort === option.value}
          className={cn(
            'min-h-10 rounded-xl border px-3.5 text-[13px] font-medium transition-colors',
            sort === option.value
              ? 'border-accent/50 bg-accent/15 text-accent'
              : 'border-line bg-panel text-muted hover:border-line-strong hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function createSessionSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000) + 1
}

export function VideosPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [sort, setSort] = useState<VideoSort>('latest')
  const sessionSeed = useRef(createSessionSeed())
  const sharedId = params.get('v')
  const openedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!sharedId || openedFor.current === sharedId) return
    openedFor.current = sharedId
    setParams(
      (current) => {
        current.delete('v')
        return current
      },
      { replace: true },
    )
    void api
      .asset(sharedId)
      .then((asset) => {
        if (asset.kind === 'video') {
          useViewer.getState().open([asset], 0, {
            filter: {
              kind: 'video',
              sort,
              ...(sort === 'rate' ? { seed: sessionSeed.current } : {}),
            },
          })
        }
      })
      .catch(() => {
        useUi.getState().toast('공유된 영상을 열 수 없습니다.', 'error')
      })
  }, [sharedId, setParams])

  const filters = {
    kind: 'video' as const,
    sort,
    ...(sort === 'rate' ? { seed: sessionSeed.current } : {}),
  }

  return (
    <>
      <AssetGallery
        title="동영상"
        filters={filters}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SortBar sort={sort} onChange={setSort} />
            <Link to="/videos/tags">
              <Button size="sm">
                <Tag size={13} />
                태그별 보기
              </Button>
            </Link>
          </div>
        }
        emptyTitle="동영상이 없습니다"
        emptyBody="MP4, MOV, MKV, WebM 파일을 스캔하면 여기에 모입니다."
        emptyIcon={<Film size={20} />}
        emptyAction={<Button onClick={() => navigate('/settings')}>라이브러리 추가</Button>}
      />
    </>
  )
}

export function VideoTagsPage() {
  const { tagId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [sort, setSort] = useState<VideoSort>('latest')
  const sessionSeed = useRef(createSessionSeed())
  const [newTagName, setNewTagName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.tags })

  const createTag = useMutation({
    mutationFn: (name: string) => api.createTag(name),
    onSuccess: () => {
      setNewTagName('')
      queryClient.invalidateQueries({ queryKey: ['tags'] })
      toast('태그를 생성했습니다.', 'success')
    },
    onError: (err) => toast(err instanceof Error ? err.message : '태그를 만들지 못했습니다.', 'error'),
  })

  const renameTag = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameTag(id, name),
    onSuccess: () => {
      setEditingId(null)
      queryClient.invalidateQueries({ queryKey: ['tags'] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      toast('태그 이름을 변경했습니다.', 'success')
    },
    onError: (err) => toast(err instanceof Error ? err.message : '태그 이름을 바꾸지 못했습니다.', 'error'),
  })

  const deleteTag = useMutation({
    mutationFn: (id: string) => api.deleteTag(id),
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['tags'] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      if (tagId === deletedId) navigate('/videos/tags')
      toast('태그를 삭제했습니다.')
    },
    onError: (err) => toast(err instanceof Error ? err.message : '태그를 삭제하지 못했습니다.', 'error'),
  })

  const tags = tagsQuery.data?.tags ?? []
  const selectedTag = tagId ? tags.find((t) => t.id === tagId) : undefined

  if (tagId) {
    return (
      <>
        <AssetGallery
          title={selectedTag ? `# ${selectedTag.name}` : '태그 동영상'}
          filters={{
            kind: 'video',
            tagId,
            sort,
            ...(sort === 'rate' ? { seed: sessionSeed.current } : {}),
          }}
          breadcrumb={
            <div className="pt-4">
              <Link
                to="/videos/tags"
                className="inline-flex items-center gap-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
              >
                <ArrowLeft size={14} />
                태그별 보기로 돌아가기
              </Link>
            </div>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SortBar sort={sort} onChange={setSort} />
            </div>
          }
          emptyTitle="이 태그의 동영상이 없습니다"
          emptyBody="동영상 상세 화면에서 이 태그를 지정하면 여기에 표시됩니다."
          emptyIcon={<Tag size={20} />}
          emptyAction={<Button onClick={() => navigate('/videos')}>전체 동영상</Button>}
        />
      </>
    )
  }

  const populatedTags = tags.filter((tag) => tag.assetCount > 0)

  return (
    <div className="h-full overflow-y-auto workspace-page">
      <PageHeading
        title="태그별 보기"
        meta={`${formatCount(populatedTags.length)}개 태그 폴더 · 전체 ${formatCount(tags.length)}개 태그`}
        actions={
          <Link to="/videos">
            <Button size="sm">전체 동영상 보기</Button>
          </Link>
        }
      />

      <div className="mb-7 rounded-panel border border-line bg-panel p-5 shadow-[var(--ui-elevation)] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = newTagName.trim()
              if (trimmed) createTag.mutate(trimmed)
            }}
          >
            <Input
              value={newTagName}
              onChange={(event) => setNewTagName(event.target.value)}
              placeholder="새 태그 이름"
              className="w-full min-w-0 sm:w-64"
            />
            <Button type="submit" size="sm" variant="primary" disabled={!newTagName.trim() || createTag.isPending}>
              <Plus size={13} />
              태그 만들기
            </Button>
          </form>
        </div>

        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {tags.map((tag) =>
              editingId === tag.id ? (
                <form
                  key={tag.id}
                  className="inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-panel-2 px-2 py-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (editingName.trim()) renameTag.mutate({ id: tag.id, name: editingName.trim() })
                  }}
                >
                  <input
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    autoFocus
                    className="w-28 bg-transparent text-[12px] text-ink focus:outline-none"
                  />
                  <button type="submit" aria-label="저장" className="text-accent hover:text-white">
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    aria-label="취소"
                    className="text-muted hover:text-ink"
                  >
                    <X size={13} />
                  </button>
                </form>
              ) : (
                <div
                  key={tag.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 py-1 text-[12px] text-ink"
                >
                  <Tag size={11} className="text-accent" />
                  <span>{tag.name}</span>
                  <span className="text-[11px] tabular-nums text-faint">
                    ({formatCount(tag.assetCount)})
                  </span>
                  <button
                    type="button"
                    aria-label={`${tag.name} 이름 변경`}
                    onClick={() => {
                      setEditingId(tag.id)
                      setEditingName(tag.name)
                    }}
                    className="ml-0.5 text-faint hover:text-ink"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${tag.name} 삭제`}
                    onClick={() => deleteTag.mutate(tag.id)}
                    className="text-faint hover:text-[#ff8a8a]"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>

      {tagsQuery.isPending ? (
        <LoadingBlock label="태그 목록을 불러오는 중" />
      ) : populatedTags.length === 0 ? (
        <EmptyState
          title="표시할 태그 폴더가 없습니다"
          body="동영상 재생 화면에서 태그를 지정하면 태그별 폴더 카드가 여기에 생성됩니다."
          icon={<Tag size={20} />}
          action={<Button onClick={() => navigate('/videos')}>전체 동영상으로 이동</Button>}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {populatedTags.map((tag) => (
            <Link
              key={tag.id}
              to={`/videos/tags/${tag.id}`}
              className="group overflow-hidden rounded-panel border border-line bg-panel transition-colors duration-150 hover:border-line-strong"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-panel-2">
                {tag.coverAssetId ? (
                  <Thumb
                    src={`/api/assets/${tag.coverAssetId}/thumbnail?size=640&pv=${tag.coverPosterVersion ?? 1}&p=${POSTER_SCHEME}`}
                    alt={tag.name}
                    className="h-full w-full"
                    imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-faint">
                    <FolderIcon size={26} strokeWidth={1.4} />
                  </div>
                )}
                <span className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent" />
              </div>
              <div className="flex items-center gap-2 px-3.5 py-2.5">
                <Tag size={14} className="shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{tag.name}</p>
                  <p className="text-[11.5px] text-muted">{formatCount(tag.assetCount)}개 동영상</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
