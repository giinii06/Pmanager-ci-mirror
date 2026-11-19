# Current Task

- **Active Phase / Wave:** Spec v1.0 PR 02 committed -> live v16 migration, then PR 03 (Mutation Engine)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`)
- **Baseline Commit:** `aceb0ade51f464c94e8f148d6a9da3445e7a6d37`
- **Live Win11 Host:** `media-server` (`192.168.0.27`, `~/Pmanager`), currently schema `v15`, `12,851` active assets, `115` folders, `63` tags, `1` library.
- **PR 02 Status:** Schema `v16` library health and scanner guards committed after `318 pass / 0 fail`, web build `0`, and a v15-to-v16 rehearsal on a real backup clone with identical counts and `integrity_check = ok`.
- **Next Action:** Deploy PR 02. Stop `api` and `worker`, create a pre-v16 backup, run the single migrator, compare counts, start `api` and `worker`, then verify `/api/libraries/:id/health` and the Settings health badge on the live host.
