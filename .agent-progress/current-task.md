# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 07 deployed and verified on the live host -> PR 08 (Job Engine)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37`
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`), now schema `v20`, `12,851` active assets, `115` folders, `63` tags, `2` users, `1` library, health `ONLINE`.
- **PR 03 Status:** Committed as `55e7549`, migrated live (`16 -> 17`), engine off: delete routes return `503`, `file_mutations` is empty, a manual scan removed nothing.
- **PR 04 Status:** Committed as `deb605c`, migrated live (`17 -> 18`), flag off: HLS tables empty, the legacy playlist still serves `200`, and the player polls the status route.
- **PR 05 Status:** Committed as `be9071f` with the `d9fbf87` nginx fix, migrated live (`18 -> 19`). Sessions are server-side rows keyed by an HMAC digest; the old HMAC cookies are rejected, a minted session authenticates and revokes on logout, and the origin check passes for the LAN origin. All browsers must sign in once with their existing password.
- **PR 06 Status:** Committed as `845d81a`, migrated live (`19 -> 20`). `play_sessions`/`play_events` make views, watch time and progress idempotent per client event id with a contiguous per-session `seq`; the legacy progress write is fenced; the resume state machine keeps a user seek; votes accept a client request id. Live counters unchanged, new endpoints `401` unauthenticated.
- **PR 07 Status:** Committed as `3881e44` and deployed: `GET /api/assets/:id/neighbor` and `POST /api/assets/random`, a viewer session/request guard, and no client ID pool. `453 pass, 0 fail`; neighbour p95 `12.84 ms` on the live clone and matching the list order on live data. No schema change.
- **Next Action:** Start PR 08 (Job Engine). Read spec section D-01/D-02 for the unified scene queue, GPU ETA, checkpoints, error codes and timeouts before changing `jobs.ts` or the worker loop.
- **Operator Follow-up:** the staged Windows supervisor scripts still lack `compose.drives.yaml`; the elevated `install-service.ps1` run is pending (see `pending-tasks.md`). Do not enable `FILE_MUTATION_ENGINE_ENABLED` or `HLS_GENERATIONS_ENABLED` on the host until their fixture rehearsals are recorded. If the login password is lost, use `scripts/reset-password.ts` (documented in `docs/RECOVERY.md`).
