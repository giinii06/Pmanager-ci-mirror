# Current Task

- **Active Phase / Wave:** Wave 2 Complete -> Starting Wave 3 (Scan Benchmarks, Two-Stage Resumable Scanner, Crash-Safe Worker, Drive Explorer & Ops APIs)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`, Wave 1 at `732576c`, committing Wave 2 next)
- **Live Win11 Host:** `giini@192.168.0.27` (`~/Pmanager`, WSL `3.0.5.0` `Ubuntu-24.04`, native `docker.service`, ASRock `B650M PG Lightning`)
- **Active Migration:** Schema `v14` implemented & tested locally (`131 pass` in `packages/database`); not yet deployed to Win11 host (backup verified in `~/Pmanager-backups/pre-v14-*`)
- **Next Action:** Write and run `scripts/bench-scan.ts` to capture baseline scan timings, then optimize and split `apps/worker/src/scan.ts` into resumable indexing + full verification reconciliation, update `apps/worker/src/{loop,handlers,recovery}.ts`, `packages/media`, `compose.yaml`, and `apps/api/src/routes/{fs,libraries,system}.ts`.
