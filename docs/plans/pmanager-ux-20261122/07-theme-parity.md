# 07-theme-parity

## Outcome
기존 light/ash/dark/onyx 각 테마의 모든 페이지, 대화상자, 오버레이, 포커스·호버·선택·에러 색상을 전체 점검.

## Observable acceptance
테마 스위치/새로고침 반영 및 접근성 대비, 반응형, 비디오/이미지 뷰어, 모바일/데스크톱 visual regression.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `8ab06544a39051302b6ca5b7af9d4070e6ee9c45`; **blocked/unverified**. Palette token replacements across major photo/video/related/review/transcript chrome; exact visual parity and accessibility checks NOT run.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
