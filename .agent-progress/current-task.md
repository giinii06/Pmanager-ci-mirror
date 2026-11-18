# Current Task

- **Active Phase / Wave:** Wave 1 (Agent Environment, UI Skill & Backup Complete) -> Moving into Wave 2 (Schema v14 & Database Layer)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`, base commit `763c1be`)
- **Live Win11 Host:** `giini@192.168.0.27` (`~/Pmanager`, WSL `3.0.5.0` `Ubuntu-24.04`, native `docker.service`, ASRock `B650M PG Lightning`)
- **Active Migration:** Pending Schema `v13` -> `v14` (`packages/database/src/schema.ts`, pre-v14 SQLite backup verified on host)
- **Files Created in Wave 1:**
  - `.agents/skills/frontend-design/{SKILL.md,LICENSE.txt,ORIGIN.json}`
  - `.agent-progress/{README,current-task,completed-tasks,pending-tasks,decisions,verification,recovery}.md`
- **Next Action:** Implement Wave 2 (`packages/shared/src/domain.ts`, `packages/database/src/{db,schema,jobs,folders,assets,contributions,backup,types,index}.ts`, and `v14.test.ts`), run `typecheck` and `bun test packages/database`, update `.agent-progress/`, and commit.
