# Phase 03 — Album deletion

**State:** implementation_committed; verification_blocked (tests authored but not executed). **Dependency:** phases 01/02 independent, but both exposed in final UI.
- Reuse existing permanent file delete mutation queue. One durable API request snapshots **direct images** in the selected folder and enqueues a uniquely keyed operation for each, in a transaction. The existing single mutation loop processes files serially, survives tab close and protects original-file identity.
- The request must validate folder, online library, idempotency key and mutation feature flag. It must never sweep nested folders, videos or unindexed files. Do not recursively delete the folder path.
- Put delete controls beside folder-card Vote and folder-detail Vote; require explicit dangerous-action confirmation with affected image count; after HTTP 202 hide from the UI without waiting for disk purge; on rejected request restore UI.
- Expose follow-up status for progress/failure, do not report successful purge until confirmed; background status error must not pretend the original is gone.
- Test: direct-image targeting; no child folders/videos; duplicate submission; zero-image folder; offline/disabled; blocked worker; retry visibility; queue continues after navigating away.
- Verify: API/DB/web tests and exact-SHA provider jobs.
