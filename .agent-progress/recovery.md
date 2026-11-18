# Crash Recovery Guide for AI Coding Agents

If the machine powered off or the session terminated unexpectedly, run these read-only checks before writing any code:

1. **Inspect Git & Workspace State:**
   ```bash
   cd /Users/xo/cod/Pmanager
   git status -s
   git log -n 10 --oneline
   ```
   Check if any uncommitted files exist in the working tree. Compare modified files against `.agent-progress/current-task.md` and `.agent-progress/pending-tasks.md`.

2. **Re-Verify Codebase Reality (Never Trust Markdown Alone):**
   ```bash
   bun run typecheck
   bun test
   bun run --cwd apps/web build
   ```
   Verify which wave last passed cleanly versus what exists half-finished in `git diff`. If uncommitted edits are broken or half-applied, inspect `git diff` and either finish the failing unit or restore cleanly.

3. **Check Win11 Host Database & Container State (when SSH is reachable):**
   ```bash
   ssh media-server 'cd ~/Pmanager && git log -n 3 --oneline && docker compose --env-file .env --env-file .env.asr --env-file .env.translation --env-file .env.embedding --env-file .env.scene -f compose.yaml -f compose.asr.models.yaml -f compose.asr.cuda.yaml -f compose.translation.models.yaml -f compose.translation.cuda.yaml -f compose.embedding.models.yaml -f compose.embedding.cuda.yaml -f compose.gpu.yaml -f compose.scene.models.yaml -f compose.scene.cuda.yaml ps'
   ```
   Always verify live `PRAGMA user_version` and row counts (`assets`, `folders`, `vote_events`, `tags`) before assuming a deployment or migration completed.

4. **Continue Execution:**
   Read `.agent-progress/current-task.md`, `.agents/skills/frontend-design/SKILL.md`, and `/Users/xo/.gemini/config/plugins/pstack/skills/poteto-mode/SKILL.md`, then resume from the first unchecked wave in `.agent-progress/pending-tasks.md`.
