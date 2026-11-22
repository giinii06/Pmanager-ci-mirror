# 01-random-sorting

## Outcome
사진 폴더와 동영상(태그 포함)에 랜덤순을 조회수순 왼쪽에 배치하고 기본값으로 설정. 셔플 결과는 화면 내 탐색 중 안정적이어야 함.

## Observable acceptance
GET /api/assets?kind=video&sort=random&seed=N returns repeatable non-duplicated pages; photos folder random ordering works; existing sort modes retained.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `8da488202513a59ee455f63e8056d248c0441975`; **blocked/unverified**. Photo and video random sort defaults added; missing tag import repaired in later SHA. Real provider status on initial implementation is FAILED, logs inaccessible.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
