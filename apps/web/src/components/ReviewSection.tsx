import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Star, Trash2 } from 'lucide-react'
import type { AssetDTO } from '@mediavault/shared'
import { api, ApiError } from '../lib/api'
import { formatDay } from '../lib/format'
import { useUi } from '../store/ui'

const STAR_COLOR = '#ffb020'

function StarRow({ rating, size = 15 }: { rating: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`별점 ${rating}점`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          size={size}
          aria-hidden
          fill={value <= rating ? STAR_COLOR : 'none'}
          className={value <= rating ? 'text-[#ffb020]' : 'text-white/20'}
        />
      ))}
    </span>
  )
}

export function ReviewSection({ asset }: { asset: AssetDTO }) {
  const queryClient = useQueryClient()
  const toast = useUi((state) => state.toast)
  const [rating, setRating] = useState(0)
  const [body, setBody] = useState('')

  const reviewQuery = useQuery({
    queryKey: ['review', asset.id],
    queryFn: () => api.review(asset.id),
    staleTime: 30_000,
  })
  const review = reviewQuery.data?.review ?? null

  useEffect(() => {
    if (!review) return
    setRating(review.rating)
    setBody(review.body)
    // Only a different saved review should refill the composer; typing must win.
  }, [review?.id, review?.updatedAt])

  const save = useMutation({
    mutationFn: () => api.saveReview(asset.id, { rating, body: body.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['review', asset.id] })
      toast('후기를 저장했습니다.', 'success')
    },
    onError: (error) => {
      toast(error instanceof ApiError ? error.message : '후기를 저장하지 못했습니다.', 'error')
    },
  })

  const remove = useMutation({
    mutationFn: () => api.deleteReview(asset.id),
    onSuccess: () => {
      setRating(0)
      setBody('')
      void queryClient.invalidateQueries({ queryKey: ['review', asset.id] })
      toast('후기를 삭제했습니다.')
    },
    onError: () => {
      toast('후기를 삭제하지 못했습니다.', 'error')
    },
  })

  const canSubmit = rating > 0 && body.trim().length > 0

  return (
    <section className="mt-8">
      <h2 className="text-[18px] font-semibold tracking-tight text-white">후기 {review ? 1 : 0}개</h2>

      <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[12.5px] font-semibold text-accent">
            나
          </span>
          <div className="flex items-center gap-0.5" role="radiogroup" aria-label="별점">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                aria-label={`별 ${value}개`}
                onClick={() => setRating(value)}
                className="rounded p-0.5 transition-transform hover:scale-110"
              >
                <Star
                  size={21}
                  fill={value <= rating ? STAR_COLOR : 'none'}
                  className={value <= rating ? 'text-[#ffb020]' : 'text-white/25'}
                />
              </button>
            ))}
          </div>
        </div>

        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={4000}
          aria-label="후기"
          placeholder={
            review
              ? '후기를 고쳐 보세요.'
              : '이 영상에 대한 후기를 남겨 보세요.'
          }
          className="mt-3 w-full resize-y rounded-xl border border-white/10 bg-[#0f0f0f] px-4 py-3 text-[14px] leading-relaxed text-white outline-none transition-shadow placeholder:text-white/40 focus:border-white/25 focus:ring-2 focus:ring-white/10"
        />

        <div className="mt-2 flex items-center justify-end gap-1.5">
          {review ? (
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-white/50 transition-colors hover:bg-white/10 hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
              삭제
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!canSubmit || save.isPending}
            className="min-h-10 rounded-xl bg-accent px-4 text-[13px] font-semibold text-[#0b0c0f] transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          >
            {save.isPending ? '저장 중' : review ? '수정' : '등록'}
          </button>
        </div>
      </div>

      {review ? (
        <article className="mt-4 flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[13px] font-semibold text-accent">
            나
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-white">나</span>
              <span className="text-[12px] text-white/45">{formatDay(review.updatedAt)}</span>
            </div>
            <div className="mt-0.5">
              <StarRow rating={review.rating} />
            </div>
            <p className="mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed text-white/85">
              {review.body}
            </p>
          </div>
        </article>
      ) : reviewQuery.isPending ? null : (
        <p className="mt-4 text-[13px] text-white/45">
          아직 후기가 없습니다. 이 영상을 어떻게 봤는지 남겨 보세요.
        </p>
      )}
    </section>
  )
}
