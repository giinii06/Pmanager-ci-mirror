# Photo tags and album deletion

**Target:** GitLab `blond11qq/Pmanager`, `feature/photo-tags-album-delete` from `main@cafecaa5a06fdcbae4f2b98ad0a3ff1d2548b361`.
**Gate:** Alchemy 2.2. **CI authority:** effective GitLab `ci_config_path=.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` (GitHub Actions bridge; actual job evidence must be checked).

## Outcome
- Each image has independently managed photo tags, separate from the video tag namespace, with photo tag browsing and editing on the photo viewer.
- Each photo folder card has an album-delete button adjacent to Vote. Confirming permanent deletion hides the album immediately in the requesting UI after durable queue acceptance; worker deletes the **direct image assets only** in sequence.
- Never delete videos, nested child folders or their images, or unrelated filesystem contents as collateral. Preserve existing video tag behavior, voting and navigation.
- Reject disabled mutation engine, offline library and invalid folders; retrying the same idempotency key never duplicates file deletions; surface background failures and restore the UI when the operation cannot be accepted.

## Plan
1. [Phase 01 — Photo-specific tag model/API](./phase-01-tags.md): migration, scoped tag operations, filtered image queries, behavior tests.
2. [Phase 02 — Photo tag UI](./phase-02-ui.md): browse/manage photo tags; photo viewer add/remove.
3. [Phase 03 — Album delete queue/UI](./phase-03-delete.md): safe batch enqueue, card/detail buttons, confirmation, optimistic UI and tests.
4. [Phase 04 — Integrated validation](./phase-04-validation.md): cross-flow tests, source review, exact-SHA CI evidence, Draft MR.

## Boundaries
Album here means the indexed photo grouping represented by a disk folder, not an independent virtual collection. Original photo files are permanently deleted through existing safeguarded file mutations; the directory itself is not recursively removed. No repository merge, deployment or CI runner/mirror changes.

## Evidence status (2026-11-22)
- Implementation committed across photo tag schema/API, photo tag routes/viewer, and album queued deletion UI/API/DB.
- Tests are **authored, not executed**. No Bun runtime or independently verified test executor is available in this session; code quality and runtime behavior remain unverified.
- GitLab pipeline [3098804081](https://gitlab.com/blond11qq/Pmanager/-/pipelines/3098804081) on 29606125 is marked success, **but has zero actual jobs**; its downstream `ci-hub-smoke` pipeline 3098804108 is **skipped**. This is dispatch evidence only; it is NOT a passing GitHub Actions or test result.
- No real-world files were deleted; only code and migrations committed. No merge, deployment, runner or mirror changes.
- The remaining gate is an exact-source-SHA GitHub Actions `release:check` or equivalent real test run, plus UI smoke.

