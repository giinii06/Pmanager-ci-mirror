# poda rebrand — Alchemy 2.2

- Target: `blond11qq/Pmanager` (GitLab project ID 89249595).
- Base: `main` at `1b93de4a6441bedca36dc1787a5190c48a76afcc`.
- Work branch: `feature/poda-branding-20261122`.
- Selected CI: GitLab effective `ci_config_path=.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke`; requests GitHub Actions and must not be mistaken for executed jobs.
- User-approved logo: uploaded navy circular P/play PNG, resized conservatively for website use.
- User-approved new user-visible product name: **poda** (lowercase).

## Outcome / acceptance
1. Browser tab displays title `poda` and an icon from the uploaded artwork, with an explicit favicon link.
2. Sidebar, splash, sign-in and setup surfaces show `poda` and the supplied artwork instead of MediaVault/Aperture.
3. Accessible alt/labels and visible help text use `poda`; project README introduces poda.
4. Existing photos, videos, direct links, settings, sessions, SQLite and Docker volumes survive the rebrand. No routing, login, migrations or storage paths are rewritten.
5. No broken favicon path, missing import or regressions from branding work. Check production web build and tests on exact candidate SHA when available.

## Compatibility boundary
Runtime identifiers `@mediavault/*`, `mediavault.*` localStorage, `MEDIAVAULT_*` deployment environment variables, Docker compose name/volumes, SQLite filenames, established GitLab/GitHub URLs and historical evidence are **legacy protocol and storage keys**, not branding. Renaming them without explicit data/CI migration would risk lost data or broken deployments. Preserve these and document them as such. The GitLab repository name/path cannot be changed using available project tools and is a separate project-settings operation; do not pretend it changed. Historical immutable planning documents are not retrospectively rewritten.

## Milestone
[Phase 01 — Branding, favicon and compatibility](./phase-01-branding.md)

## Verification and status
`gate_version=2.2`; phase state tracked in `state.json`. An unexecuted check is not marked passed. Do not merge or deploy automatically.
