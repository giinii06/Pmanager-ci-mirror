# Phase 02 — Photo tag UI

**State:** implementation_committed; verification_blocked (tests authored but not executed). **Dependency:** Phase 01.
- Add photo tag browse/management entry and navigation `/photos/tags` and `/photos/tags/:tagId`.
- Photo viewer supports attaching an existing photo tag, creating one and removing it; video tag controls remain scoped to videos.
- Tests: separate photo and video tag navigation and scoped API query; optional real-browser interaction if an executor is available.
- Negative: empty tag category and mutations failing with useful error messaging.
- Verify: web typecheck/build/test and exact-SHA provider jobs. No claim of browser E2E until actually executed.
