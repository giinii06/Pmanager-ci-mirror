# 02-album-navigation

## Outcome
앨범 페이지에서 이미지 뷰어를 열지 않은 경우 좌·우 화살표로 이웃 앨범 이동, Shuffle 버튼으로 자신을 제외한 임의의 앨범으로 이동.

## Observable acceptance
입력 영역/모달/이미지 뷰어 열림 상태에서는 키보드 충돌 없음; 단일 앨범일 때 안전하게 정지; 이동은 브라우저 기록에 남음.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `0106e248436fef493deba85095e7c8ce25c8426b`; **blocked/unverified**. Gallery album page navigation with left/right and Shuffle, excluding current; pure-function tests authored.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
