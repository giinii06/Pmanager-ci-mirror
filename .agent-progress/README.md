# MediaVault Agent Progress & Crash-Recovery State

This directory records live development progress, verified test/build checkpoints, schema migrations, architectural decisions, and recovery steps inside the repository so an AI coding agent can resume cleanly after an unexpected shutdown or power loss on Windows 11.

## Files
- `current-task.md`: Active wave, current objective, modified files in progress, and next concrete action.
- `completed-tasks.md`: Verified completed waves and deliverables with commit SHAs.
- `pending-tasks.md`: Ordered remaining waves and concrete checklists.
- `decisions.md`: Architecture, performance, security, and external tool/skill decisions (including second-opinion status).
- `verification.md`: Observed baselines, post-change benchmarks, test outputs, and live host verification results (never fabricated).
- `recovery.md`: Exact commands to re-orient after a sudden power outage or session restart by comparing disk + git state before resuming.

## Update Rule
Every completed wave must update `completed-tasks.md`, `pending-tasks.md`, `verification.md`, and `current-task.md`, verify `bun run typecheck` and tests, and commit to git on `main` before moving to the next wave.
