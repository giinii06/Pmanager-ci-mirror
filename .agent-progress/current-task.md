# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 01 committed -> live host verification, then PR 02 (Library Health)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37` (Schema `v15`)
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`), schema `v15`, `12,756` active assets, `113` folders, `63` tags.
- **PR 01 Status:** `.env*` ignores, long-syntax binds with `create_host_path: false`, `compose.drives.yaml`, `compose.dev.yaml`, ASR/scene read-only drive mounts, and `scripts/preflight.ts` are committed. Local checks: typecheck `0`, `309 pass / 0 fail`, web build `0`, all compose renders `0`, missing `MEDIA_ROOT` fails.
- **Next Action:** Deploy PR 01 to `media-server` after backing up the host `.env`, set `MEDIA_ROOT` to a real drive path, recreate `api`, `worker`, `nginx`, run the container preflight, and confirm the library still reports `12,756` assets. Then start PR 02.
