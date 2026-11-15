import type { AsrStage, TranslationStage, WorkKind, WorkPipeline } from '@mediavault/shared'

export const ASR_STAGE_LABEL: Record<AsrStage, string> = {
  queued: '대기 중',
  extracting: '오디오 추출 중',
  chunking: '음성 구간 분석 중',
  transcribing: '음성 인식 중',
  aligning: '시간 정렬 중',
  writing: '자막 저장 중',
  completed: '완료',
}

export const TRANSLATION_STAGE_LABEL: Record<TranslationStage, string> = {
  queued: '대기 중',
  starting: '번역 준비 중',
  translating: '번역 중',
  writing: '자막 저장 중',
  completed: '완료',
}

export const pipelineLabel: Record<WorkPipeline, string> = {
  media: '미디어',
  asr: '음성 인식',
  translation: '번역',
}

export const kindLabel: Record<WorkKind, string> = {
  scan_library: '폴더 스캔',
  thumbnail: '썸네일',
  preview: '프리뷰',
  hls: 'HLS 변환',
  asr: '음성 인식',
  translation: '번역',
}
