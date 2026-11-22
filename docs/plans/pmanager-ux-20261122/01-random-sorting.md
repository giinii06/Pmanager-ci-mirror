# 01-random-sorting

## Outcome
사진 폴더와 동영상(태그 포함)에 랜덤순을 조회수순 왼쪽에 배치하고 기본값으로 설정. 셔플 결과는 화면 내 탐색 중 안정적이어야 함.

## Observable acceptance
GET /api/assets?kind=video&sort=random&seed=N returns repeatable non-duplicated pages; photos folder random ordering works; existing sort modes retained.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Not started. No implementation or passing tests claimed.
