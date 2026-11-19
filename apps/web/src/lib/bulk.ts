import type {
  BulkOperationCountsDTO,
  BulkOperationKind,
  BulkOperationState,
  BulkItemState,
} from '@mediavault/shared'

export const BULK_KIND_LABEL: Record<BulkOperationKind, string> = {
  tag_add: '태그 붙이기',
  tag_remove: '태그 떼기',
  poster: '포스터 다시 만들기',
  reanalyze: 'AI 분석 다시 실행',
  move: '파일 이동',
  copy: '파일 복사',
  delete: '파일 영구 삭제',
  export: '선택 결과 내보내기',
}

export const BULK_STATE_LABEL: Record<BulkOperationState, string> = {
  queued: '대기',
  running: '진행 중',
  cancelling: '취소 중',
  cancelled: '취소됨',
  completed: '완료',
  completed_with_errors: '일부 실패',
  failed: '실패',
}

export const BULK_ITEM_STATE_LABEL: Record<BulkItemState, string> = {
  pending: '대기',
  running: '진행 중',
  succeeded: '성공',
  failed: '실패',
  held: '보류',
  cancelled: '취소',
}

export const BULK_ACTIVE_STATES: BulkOperationState[] = ['queued', 'running', 'cancelling']

export function isBulkActive(state: BulkOperationState): boolean {
  return BULK_ACTIVE_STATES.includes(state)
}

/** Finished rows over the total; running work is shown by the counts, not the bar. */
export function bulkProgress(counts: BulkOperationCountsDTO): number {
  if (counts.total === 0) return 0
  const done = counts.succeeded + counts.failed + counts.held + counts.cancelled
  return Math.round((done / counts.total) * 100)
}

export const BULK_STATE_TONE: Record<BulkOperationState, string> = {
  queued: 'border-line bg-panel-2 text-muted',
  running: 'border-accent/40 bg-accent/15 text-accent',
  cancelling: 'border-[#6b552a] bg-[#2a2417] text-[#e8c77a]',
  cancelled: 'border-line bg-panel-2 text-faint',
  completed: 'border-[#2c4a34] bg-[#16241a] text-[#7fd99a]',
  completed_with_errors: 'border-[#6b552a] bg-[#2a2417] text-[#e8c77a]',
  failed: 'border-[#4a2a2e] bg-[#2a1719] text-[#ff9c9c]',
}

export const BULK_ITEM_TONE: Record<BulkItemState, string> = {
  pending: 'text-faint',
  running: 'text-accent',
  succeeded: 'text-[#7fd99a]',
  failed: 'text-[#ff9c9c]',
  held: 'text-[#e8c77a]',
  cancelled: 'text-faint',
}
