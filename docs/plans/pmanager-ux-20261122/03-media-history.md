# 03-media-history

## Outcome
모든 사진과 동영상의 ID 기반 고유 URL과 History Back/Forward, 직접 접속, 새로고침, 미존재 ID 처리, 검색/태그/폴더에서 복귀 상태 보존.

## Observable acceptance
뷰어 열기, 다음/이전, 관련 동영상 이동, 공유 링크, 닫기를 브라우저 history로 테스트.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `438afdebea5583b932c06f048d9057195c2baaec`; **blocked/unverified**. Opaque-ID photo/video routes, viewer route hydration, canonical sharing links and History synchronization; code-only. Follow-up reserved tag URL fix and wrong-kind handling committed.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
