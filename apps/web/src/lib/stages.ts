import type {
  AsrStage,
  EmbeddingStage,
  SceneStage,
  TranslationStage,
  WorkKind,
  WorkPipeline,
} from '@mediavault/shared'

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

export const EMBEDDING_STAGE_LABEL: Record<EmbeddingStage, string> = {
  queued: '대기 중',
  starting: '임베딩 준비 중',
  embedding: '임베딩 중',
  writing: '벡터 저장 중',
  completed: '완료',
}

export const SCENE_STAGE_LABEL: Record<SceneStage, string> = {
  queued: '대기 중',
  extracting: '구간 추출 중',
  embedding: '장면 분석 중',
  writing: '장면 저장 중',
  completed: '완료',
}

export const MUTATION_STAGE_LABEL: Record<string, string> = {
  delete: '삭제',
  move: '이동',
  copy: '복사',
  extract: '압축 해제',
}

export const pipelineLabel: Record<WorkPipeline, string> = {
  media: '미디어',
  asr: '음성 인식',
  translation: '번역',
  embedding: '임베딩',
  scene: '장면 분석',
  mutation: '파일 작업',
  backup: '백업',
  maintenance: '유지보수',
  bulk: '일괄 작업',
}

export const kindLabel: Record<WorkKind, string> = {
  scan_library: '폴더 스캔',
  thumbnail: '썸네일',
  preview: '프리뷰',
  hls: 'HLS 변환',
  process_archive: '압축 해제/변환',
  asr: '음성 인식',
  translation: '번역',
  embedding: '임베딩',
  scene: '장면 분석',
  mutation: '파일 작업',
  backup: '백업',
  maintenance: '유지보수',
  bulk: '일괄 작업',
}
