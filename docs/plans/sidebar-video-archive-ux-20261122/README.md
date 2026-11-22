# Sidebar / archive history / video cards / one-click actions

Project: `blond11qq/Pmanager`; base `main` at `58e44ed5b6769de2f84a2117faf3bdfd04654f14`.
Review branch: `feature/sidebar-video-archive-ux-20261122`.
Effective CI: `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` (GitLab dispatch to external GitHub Actions, not a GitLab test runner).

## Acceptance contract
1. Desktop sidebar close collapses to **zero** width (no icon rail), leaving content space; left-edge pointer triggers a temporary expanded overlay for 3 seconds; explicit topbar toggle reopens it persistently, with saved preference. Touch/mobile drawer stays usable.
2. RAR/conversion history displays at most **5** newest records. The database removes old **terminal** records while preserving active worker jobs, and deduplication behaves safely after pruning. Existing history is trimmed on access; histories are not source media or converted files.
3. Videos and video-tag cards use the photo-style justified, aspect-preserving gallery with larger thumbnails. Photo/video/video-tag image hover **dimming** is removed without removing non-darkening metadata or accessible focus.
4. Permanent delete in video viewer and album delete starts the existing server-side deletion operation on the first click (no dialog), with pending/failed feedback and repeat-click protection. Poster selection captures the *current playback frame* on click, with no dialog, using the existing server endpoint and cache refresh. Offline, invalid duration and errors must be handled gracefully.

## Phases
- [01-behavior](./phase-01-behavior.md): behavior regression tests and implementation across frontend and archive persistence. This is a single integration slice covering the four linked user-facing flows; it can be implemented but **must remain blocked** until real tests/CI succeed.
- [02-verification](./phase-02-verification.md): run pinned-SHA automated and browser flows, review requirements/security, verify archive deletion semantics, document outcomes.

## Safety, delivery and proof
- No source media deletion during development, no deployment/merge, no CI-provider/runners/visibility changes.
- User expressly authorizes removal of extra confirmation dialogs; deletion stays asynchronous/server-authoritative and not simulated as an immediate completed file purge.
- Required repo commands: `bun test`, `bun run typecheck`, `bun run --cwd apps/web build`; direct browser E2E for desktop hover behavior/mobile, actual poster frame, destructive actions in disposable fixture only.
- Local Bun executable/checkout not available in this environment. RED/GREEN and build cannot be asserted without observed provider job evidence. Preserve a Draft MR and explicit blocked state if unavailable.
- Source from the previous eight-workstream MR !15 was merged externally while this request was being investigated; that branch was deleted. Start from fresh main instead of overwriting the deleted branch.
