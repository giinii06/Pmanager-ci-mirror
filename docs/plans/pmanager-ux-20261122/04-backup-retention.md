# 04-backup-retention

## Outcome
DB 백업은 최신 성공 스냅샷 최대 5개만 유지. 6번째 백업이 정상 검증된 후 가장 오래된 것 정리, 실패하면 기존 정상본 보존.

## Observable acceptance
API와 실제 .db 파일 카운트 일치; 동시 생성, 경로/권한 오류, 실패 및 복원 무결성 테스트.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `26274c5f72b617caa79ad0d7af3e8f72b344e7f8`; **blocked/unverified**. Successful SQLite snapshots capped at five by UTC creation filename, newest backup verified before cleanup; unit test authored. Cleanup failure remains a retention caveat.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
