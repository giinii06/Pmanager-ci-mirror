# Review — Eight Pmanager workstreams (sequential self-review)

## Scope and evidence
- Baseline `main` = `8d714bd31639bd5b7d01118f82ede67dd6d50b89`; candidate code SHA `7d681bb1c5ea7d471f2f38f8b053206ab76b815d`; GitLab Draft MR !15.
- Reviewed the live source and GitLab `compare_refs` with 58 changed paths (including docs), and inspected route, domain, schema and test diffs. Reviewer is **self**, not an independent agent.
- No local Bun executor, no observed typecheck, build, unit-test run, accessibility/visual UI suite, or deployed E2E. Code and test commits are not proof of passing tests.

## Requirements lens
1. **01-random-sorting**: Photo and video random sort defaults added; missing tag import repaired in later SHA. Real provider status on initial implementation is FAILED, logs inaccessible. Code-start SHA `8da488202513a59ee455f63e8056d248c0441975`.
2. **02-album-navigation**: Gallery album page navigation with left/right and Shuffle, excluding current; pure-function tests authored. Code-start SHA `0106e248436fef493deba85095e7c8ce25c8426b`.
3. **03-media-history**: Opaque-ID photo/video routes, viewer route hydration, canonical sharing links and History synchronization; code-only. Follow-up reserved tag URL fix and wrong-kind handling committed. Code-start SHA `438afdebea5583b932c06f048d9057195c2baaec`.
4. **04-backup-retention**: Successful SQLite snapshots capped at five by UTC creation filename, newest backup verified before cleanup; unit test authored. Cleanup failure remains a retention caveat. Code-start SHA `26274c5f72b617caa79ad0d7af3e8f72b344e7f8`.
5. **05-remove-video-bookmarks**: UI, dialog, client methods and HTTP routes removed; old DB table remains inert to avoid destructive data loss. Legacy API negative tests authored. Code-start SHA `47f9c466a41673687681846822be2fd215e48a10`.
6. **06-https**: Caddy TLS proxy, Docker Compose port bindings and secure-cookie default added; actual DNS, certificates, CA trust and on-host user flow NOT verified. Code-start SHA `63780f3ea04b89f4d6552ec53d554efb1b7538c2`.
7. **07-theme-parity**: Palette token replacements across major photo/video/related/review/transcript chrome; exact visual parity and accessibility checks NOT run. Code-start SHA `8ab06544a39051302b6ca5b7af9d4070e6ee9c45`.
8. **08-journal-block-editor**: Block document format, migration v30, private image upload/reading with ownership controls, table/board/calendar/gallery, status/tags/date/favorites/icons, rich block types/drag ordering, legacy conversion. NOT full Notion functionality; tests authored, not run. Code-start SHA `7d681bb1c5ea7d471f2f38f8b053206ab76b815d`.

## Security and quality lens
- Good: video/photo URLs use opaque IDs, media API still authenticates; journal image read/write checks authenticated page ownership, magic signatures and 5MiB size; images use DB BLOBs included in SQLite snapshots; legacy journal text remains in place until user opts in to conversion. Bookmark SQL tables remain dormant, not dropped.
- Good: random SQL uses server-selected enum and normalized seed; phase 01 source defect (missing useUi import) corrected; image type mismatch & reserved tag path routing corrected; journal schema test expected version corrected; editor empty-block IDs normalized.
- Risk: Notion-style editor uses per-block textarea and JSON serialized into existing 100k-char body field; not true full rich-text/collaboration parity, and complex content and images need browser integration tests.
- Risk: image upload checks headers/signatures but does not decode/verify full media payload; no orphan attachment garbage collection yet. Database-backed images increase SQLite and backup sizes.
- Risk: album random ordering uses SQLite RANDOM() and can reshuffle on query refetch; browser-history navigation and keyboard scope need live browser tests.
- Risk: backup cleanup catches file removal failures; max-five physical files can be exceeded under filesystem permission errors until repaired.
- Risk: full theme contrast/accessibility/visual parity, TLS trust/redirect/secure cookies and cross-origin handling need real browser and host verification.
- No production data, live DNS, SSL certificate state or deployment changed.

## Exact-SHA CI resolver
- Candidate `8da488202513a59ee455f63e8056d248c0441975` / GitLab pipeline `3098835154`: `dispatch_github_actions=success`; `github-actions/ci-hub-request=failed` (<https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44982754791>); **jobs_verified=false**.
- Candidate `e840d301e049b32515020262b7d99332fb8af027` / GitLab pipeline `3098865004`: dispatch success, external provider **failed** (<https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44983856657>); **jobs_verified=false**.
- Candidate `826e004c216e663e5f10741f65ea5b41c083d7b8` / GitLab pipeline `3098868518`: provider **canceled** while queued; not a pass.
- Candidate `7d681bb1c5ea7d471f2f38f8b053206ab76b815d` / GitLab pipeline `3098870722`: dispatch success, external provider **pending** at checkpoint (<https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44984154814>); no job logs checked.
- GitLab effective CI uses `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` rather than its dormant repo-local `.gitlab-ci.yml`. GitLab pipeline success is dispatch only. Real provider jobs/checkout SHA not visible to this executor.

## Final gate
**NOT complete or verified**. Require: exact-SHA matching provider job logs; `bun run typecheck`, `bun test`, `bun run --cwd apps/web build`, browser Back/Forward, keyboard album movement, image upload/access control, five-file rotation, all theme variants, TLS certificate/origin/cookie behavior; fix actual observed defects; re-review new SHA. Full Notion parity is still unimplemented. Draft MR is intentionally unmerged and unpublished to production.
