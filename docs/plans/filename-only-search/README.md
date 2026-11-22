# Filename-only search refactor

- **Project:** `blond11qq/Pmanager`
- **Base:** `main` at `59cfa5bf8b81db80e59122bd986cf905158bafbc`
- **Branch:** `refactor/filename-only-search`
- **gate_version:** `2.2`
- **Outcome:** Searching the media library finds **only** matching image/video filenames in the existing gallery; no scene/audio/dialogue similarity search in the global search flow.
- **Scope:** SearchPage, Topbar, client API and unused global semantic endpoint/DTO, plus behavioral tests.
- **Excluded:** removing scene/transcription/embedding workers, associated video viewer features, FTS storage migrations, changing CI/mirroring, deployment.
- **Preservation:** auth, existing /api/assets filters/cursors, viewer navigation, thumbnail rendering, video/photo galleries, advanced per-video features.
- **CI authority:** GitLab effective `ci_config_path = .gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke`, which requests GitHub Actions. GitLab `.gitlab-ci.yml` is not the effective config. Exact-SHA provider jobs are required to verify.
- **Implementation plan:** [phase-01-filename-search.md](phase-01-filename-search.md)
- **Design & acceptance:** [design.md](design.md)
- **State:** [state.json](state.json) · [review.md](review.md)

## Evidence policy

Local environment has no Bun executable and no runnable checkout, so pre-commit commands and observed RED are unavailable. Tests added in code are *not* proof they were run. At candidate SHA `396c8a150c129bc97ced519de6e037359c85d6c7`, the GitLab dispatch pipeline succeeded, **but its downstream child was skipped with a manual job and NO GitHub Actions tests were observed**. Do not mark Tested/Verified. A Draft MR is not merge/deploy authorization.
