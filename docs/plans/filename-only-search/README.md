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
- **State:** [state.json](state.json)

## Evidence policy

Local environment has no Bun executable and no authorized checkout, so pre-commit commands and observed RED are currently unavailable. Tests added in code are *not* proof they were run. After candidate commit, dispatch only the configured CI provider at the same SHA and inspect dispatch status independently from real job evidence. A Draft MR is not merge/deploy authorization.
