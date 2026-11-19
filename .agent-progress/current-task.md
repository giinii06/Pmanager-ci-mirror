# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 04 deployed and verified on the live host -> PR 05 (Auth)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37`
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`), now schema `v18`, `12,851` active assets, `115` folders, `63` tags, `1` library, health `ONLINE`.
- **PR 03 Status:** Committed as `55e7549`, migrated live (`16 -> 17`), and verified with the engine off: both delete routes return `503`, `file_mutations` is empty, the worker mutation loop is dormant, and a manual scan removed nothing.
- **PR 04 Status:** Committed as `deb605c`, migrated live (`17 -> 18`), and verified with the flag off: `hls_generations` / `hls_active` are empty, the legacy playlist still serves `200`, and the new status route reports `ready` for a cached video. The player bundle now polls the status route and shows the retry/offline states.
- **Next Action:** Start PR 05 (Auth). The spec's `v18` Argon2id slot is now `v19` because PR 04 took `v18` (decision 15). Read spec section F for Argon2id migration, server-side sessions, the login rate limit, and trusted-proxy handling before writing the migration.
- **Operator Follow-up:** the staged Windows supervisor scripts still lack `compose.drives.yaml`; the elevated `install-service.ps1` run is pending (see `pending-tasks.md`). Do not enable `FILE_MUTATION_ENGINE_ENABLED` on the host until a fixture-library delete rehearsal is recorded, and do not enable `HLS_GENERATIONS_ENABLED` until a fixture asset has produced, served, and been garbage-collected as a generation.
