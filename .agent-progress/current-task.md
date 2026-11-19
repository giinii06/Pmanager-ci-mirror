# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 02 deployed and verified on the live host -> PR 03 (Mutation Engine)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37`
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`), now schema `v16`, `12,851` active assets, `115` folders, `63` tags, `1` library, health `ONLINE`, `rootIdentity 73:4503599627428555`.
- **PR 02 Status:** Committed as `28cd1eb`, migrated live, endpoints and Settings badge verified. A blocked-scan event on live data proved the deletion guard.
- **Next Action:** Start PR 03. Read spec sections C (media mutation), D (jobs) and I (migration v17) for `file_mutations` and `mutation_events`, then implement the quarantine delete state machine behind `FILE_MUTATION_ENGINE_ENABLED`, with fixtures-only tests and SIGKILL reconciliation coverage.
- **Operator Follow-up:** the staged Windows supervisor scripts still lack `compose.drives.yaml`; the elevated `install-service.ps1` run is pending (see `pending-tasks.md`).
