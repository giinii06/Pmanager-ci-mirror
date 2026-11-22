# Phase 04 — Integration and review

**State:** not_started.
- Check migration on a pre-V28 database; tag namespace isolation through create/list/asset viewer and both browse pages.
- Verify album confirm→durable enqueue→immediate hiding→serial worker execution→completion/failure, including after tab close and transient network error.
- Verify no unrelated asset bytes or child folders modified. Check accessible keyboard labels, button nesting, failure toasts.
- Run repository's authoritative format/lint/typecheck/test/build scripts where a real executor is available; otherwise explicitly mark unavailable and inspect actual provider job logs/checkout SHA.
- Two distinct self-review lenses: acceptance requirements; security/race/idempotency.
- Record gate_version=2.2 evidence, reviewed SHA, CI provider result and job-level status; open Draft MR, do not merge/deploy.
