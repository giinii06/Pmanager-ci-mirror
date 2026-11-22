# 08-journal-block-editor

## Outcome
Notion-style block editing, page/database views, rich text, images (secure uploads/storage), tables and properties, block nesting, keyboard UX, searchable pages.

## Observable acceptance
사용자 요구 'Notion 모든 기능'의 범위는 Notion 서비스 전체 협업·자동화·외부통합·AI까지 포함할 수 있어 별도 제품 계약/상세 기능 매트릭스 없이 완전 동등성 주장 금지; 기존 텍스트 저널의 유실 없는 마이그레이션 필수.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `7d681bb1c5ea7d471f2f38f8b053206ab76b815d`; **blocked/unverified**. Block document format, migration v30, private image upload/reading with ownership controls, table/board/calendar/gallery, status/tags/date/favorites/icons, rich block types/drag ordering, legacy conversion. NOT full Notion functionality; tests authored, not run.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
