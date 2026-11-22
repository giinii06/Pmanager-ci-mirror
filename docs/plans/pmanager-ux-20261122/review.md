# Review — media random sorting (self-review only)

## Requirements lens
- Both photo folder grid and videos default to random; the button precedes views; image tag galleries also expose applicable sorts.
- Video random order has a stable per-mount seed propagated to API and neighbor filtering, and a deterministic ID tie-breaker.
- Folder random order is SQLite RANDOM() per query; refetch reshuffles. No stable-seed contract for photo folders exists yet.
- Additional requested phases 02–08 are NOT implemented or delivered.

## Security / quality lens
- Random SQL expressions are selected from server-side enum, not injected from user input. Video seed is numeric and constrained through Zod.
- No file deletion, TLS settings, schema migrations or deployment were performed.
- Tests have been committed to `apps/api/src/overhaul.test.ts` but NOT run; there is no local checkout/Bun executable.
- Risk: there is no browser E2E proof for sort controls, no paging stress proof, no remote typecheck/build/job logs.

## CI evidence
- Code SHA `e06e744707c205c7fdf492ad59d0b932b516da64` / pipeline `3098833700`: dispatch_github_actions success; list_pipeline_jobs empty.
- Code SHA `8da488202513a59ee455f63e8056d248c0441975` / pipeline `3098835154`: dispatch_github_actions success; list_pipeline_jobs empty.
- Effective project ci_config_path points at `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke`; status reported is dispatch success only. No provider job SHA/logs were available for verification.

## Gate status
Blocked, NOT tested, NOT verified, NOT completed. Next work requires matching provider jobs with commands for unit tests/typecheck/web build and a browser user-flow check, or an explicitly approved scoped waiver. Do not merge or deploy this Draft MR.
