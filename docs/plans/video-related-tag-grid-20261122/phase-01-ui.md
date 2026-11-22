# Phase 01 — UI behavior and regression tests

State: not_started (gate_version 2.2). TypeScript React + Bun per repo manifests.

1. Establish RED test for justified tag covers: varying aspect ratios must retain cover proportions and fully pack complete rows with no overflow; unknown dimensions and incomplete last row remain safe. Execute with `bun test apps/web/src/lib/tagLayout.test.ts` when a genuine Bun checkout is available. If unavailable, record RED unverified, never invent a failure.
2. Implement a tag-cover layout helper consuming `TagSummaryDTO`, translating `coverWidth / coverHeight` into shared `buildGalleryEntries`, `targetHeight: 320`, `gap: 8`; reuse the result in a responsive tag overview component. Keep photo tags on the existing grid.
3. Double related-video image CSS size to 336 x 188, move text underneath the image to avoid stealing width at the 424px sidebar, cap thumbnail at 100% parent width.
4. Inspect diff; run `bun test`, `bun run typecheck`, `bun run --cwd apps/web build` if checkout and dependencies available; if not, mark not executed. Record exact committed SHA and provider evidence before claiming verification.

Failure checks: empty/loading state; missing poster; portrait, landscape, panorama; resize and mobile width; links and tab focus; many tag covers; photo tag parity. No data schema or API mutation.

## Implementation checkpoint
- Candidate code SHA: `e4244a438f6b66128623bd12afb1cd3ad18021a0`; tests authored in `apps/web/src/lib/videoTagLayout.test.ts` but RED/GREEN unobserved.
- Changes: `RelatedVideos.tsx`, `VideoTagGrid.tsx`, `videoTagLayout.ts`, `GalleryPages.tsx`.
- No Bun runner/checked-out dependencies available; `bun test`, `bun run typecheck`, `bun run --cwd apps/web build` were NOT executed. External dispatch-only pipeline 3098912891; provider job results unknown.
- Review: [review.md](./review.md). State BLOCKED pending exact-SHA job and responsive browser E2E proof; no waiver.
