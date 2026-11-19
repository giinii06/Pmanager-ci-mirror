# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 00 complete -> PR 01 (Ignore, Compose, Preflight)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37` (Schema `v15`, `298 pass / 0 fail`)
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`, WSL2 Ubuntu 24.04, native `docker.service` + `ssh.service`)
- **Live Data Status:** Schema `v15`, `12,756` active assets, `113` folders, `63` tags, `1` library, `191` playback rows, `1` vote event; `integrity_check = ok`, `foreign_key_check = 0`; latest backup `mediavault-2026-11-19T03-25-54-233Z-r777ns.db` verified and restore-rehearsed on a temp copy.
- **Next Action:** PR 01. Add `.env*` ignore rules, long-syntax Compose binds with `create_host_path: false`, required drive paths, ASR/scene read-only drive mounts, and a preflight script with regression tests. Commit only after typecheck, tests, web build, and Compose config checks pass.
