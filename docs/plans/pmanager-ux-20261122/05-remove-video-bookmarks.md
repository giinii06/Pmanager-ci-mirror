# 05-remove-video-bookmarks

## Outcome
동영상 UI·대화상자·클라이언트 호출·API 등록에서 북마크 기능 제거. 기존 DB 테이블은 파괴적 마이그레이션 없이 보존.

## Observable acceptance
북마크 버튼 및 접근 가능한 API가 없어야 함; 재생 위치 자동 저장 등 독립 기능은 유지.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Not started. No implementation or passing tests claimed.
