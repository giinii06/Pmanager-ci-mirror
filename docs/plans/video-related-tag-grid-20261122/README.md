# Larger related videos and justified video-tag folders

Project: blond11qq/Pmanager. Baseline main SHA: `5b73bbd1e62fea239161f46a70c066f4cbcb5005`.
Review branch: `feature/video-related-tag-grid-20261122`.
Effective CI: `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` (GitLab dispatch to external GitHub Actions; the GitLab dispatch is not test execution).

## User-visible acceptance
1. Opening a video displays related-video thumbnails at 336 x 188 CSS px rather than 168 x 94, with filenames and metadata readable below, without clipping on narrow viewports.
2. /videos/tags tag-folder covers use the same aspect-preserving justified-row layout as /videos: mixed portrait/landscape covers pack contiguous rows across available width rather than a 1/2/3-column fixed-grid layout. Card labels and counts remain visible and selecting a tag still opens its filtered media.
3. Photo tags, selected video-tag media galleries, video player, routing, and tag create/rename/delete behavior remain intact.
4. Negative cases: no covers, missing/invalid cover dimensions, one-item final row, window resize, mobile, tall/wide covers, focus/keyboard, no tag items.

## Plan and review
- [Phase 01](./phase-01-ui.md): add regression tests and implement related thumbnails plus video tag-cover layout using the existing gallery packing algorithm.
- [Phase 02](./phase-02-verification.md): run pinned-SHA validation and inspect both user flows, plus two-lens code review.
- Never merge/deploy or change runner/mirror/CI configuration without separate authorization. UI-only rollback: revert the feature commit(s).
- CI claims: dispatch, provider callback, actual jobs, and browser E2E are separate. A missing Bun executor or downstream logs leave the phase blocked.

## Implementation checkpoint — 2026-11-22
- Source candidate SHA: `e4244a438f6b66128623bd12afb1cd3ad18021a0`. Related thumbnail size doubled and video-tag justified overview implemented; media route and photo tags retained.
- New layout tests authored but NOT executed. No local Bun executor, typecheck/build or browser E2E proof.
- [GitLab pipeline 3098912891](https://gitlab.com/blond11qq/Pmanager/-/pipelines/3098912891): dispatch success only. External provider run observed as PENDING, actual job logs unknown.
- [Two-lens self-review](./review.md) at candidate SHA; both phases blocked/unverified. No merge/deployment.
