# Phase 02 — exact-SHA and user-flow verification

State: not_started. Gate version 2.2.

1. Pin candidate SHA after Phase 01; discover effective CI (GitLab bridge), pipeline ID and its matching commit statuses. Treat dispatch, provider result, jobs verified and E2E as four separate stages.
2. Check actual external GitHub Actions checkout SHA, commands and job logs. Mandatory suites: Bun tests (including archive and Web), TypeScript typecheck, web production build. No completion on dispatch success alone.
3. Test desktop sidebar 0px and 3s peek, 1280px/desktop and touch layout; video grid natural ratio (landscape/portrait) and photo/video/tag hover; archive 6th completed insertion with active job; instant file and album deletion in disposable test fixture, poster at current playback frame, back-navigation after deletion.
4. Two-pass diff review: requirements parity + quality/security/data-loss race conditions. Record self versus independent reviewer honestly, evidence and exact reviewed SHA.
5. Update `state.json` with append-only observed transitions; remain blocked until actual proof. Keep Draft MR; do not merge/deploy.
