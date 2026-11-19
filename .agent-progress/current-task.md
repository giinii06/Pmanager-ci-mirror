# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 03 deployed and verified on the live host -> PR 04 (Cache/HLS generations)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37`
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`), now schema `v17`, `12,851` active assets, `115` folders, `63` tags, `1` library, health `ONLINE`.
- **PR 03 Status:** Committed as `55e7549`, migrated live (`16 -> 17`), and verified with the engine off: both delete routes return `503`, `file_mutations` is empty, the worker mutation loop is dormant, and a manual scan removed nothing.
- **Next Action:** Start PR 04. Read spec sections E (cache/HLS) and I-01 (`v18` `hls_generations` / `hls_active` after the PR 03 shift) for immutable generation publishing, then implement behind `HLS_GENERATIONS_ENABLED` with cache-miss and partial-generation tests.
- **Operator Follow-up:** the staged Windows supervisor scripts still lack `compose.drives.yaml`; the elevated `install-service.ps1` run is pending (see `pending-tasks.md`). Do not enable `FILE_MUTATION_ENGINE_ENABLED` on the host until a fixture-library delete rehearsal is recorded.
