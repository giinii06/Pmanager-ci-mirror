# Phase 1 — timeline preview
- Shared: 5-second sampling; 5×5 tiles per sheet (125 seconds), versioned cache.
- Media: FFmpeg extracts a bounded page and publishes atomically only for current asset/worker lease; cache lives alongside versioned thumbnails.
- Worker: reuse thumbnail queue with explicit page/version payload; low-priority scan backfill, promote requested pages; skip ready pages.
- API: authenticated, bounds/version-checked sprite request; 202 while pending, private immutable cache on success, no direct filesystem paths.
- Player: custom range retains seeking; pointer movement shows timestamp and cached sheet crop; touch drag, DOM fullscreen, edge clamping; pending/error falls back to timestamp. Native iOS fullscreen cannot show DOM overlays.
- Acceptance (not executed by request): hovering does not seek or report watch time; clicks still seek; time-to-tile mapping, short/final page, missing/changed/deleted asset, cache/offline, pointer leave/cancel, Direct Play/HLS.
- Rollback: revert this branch; no DB migration or original media changes. Generated cache is disposable.
- Verification: expressly waived by user, no RED/GREEN, format/typecheck/build/CI/E2E/review execution. No passing result claimed.
