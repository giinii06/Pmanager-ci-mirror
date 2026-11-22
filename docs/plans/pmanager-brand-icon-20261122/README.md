# Pmanager brand icon — Alchemy 2.2

- Project: `blond11qq/Pmanager`
- Base: `main` at `1b93de4a6441bedca36dc1787a5190c48a76afcc`
- Branch: `feature/pmanager-logo-20261122`
- Approved design: use the exact user-uploaded muted blue circular P/play icon, not a new illustration.
- Scope: browser favicon and existing visual brand marks in sidebar, authentication, and loading screens.
- Non-scope: product text rename (currently MediaVault), routes, backend, theming, deployments, and GitLab settings.
- Delivery: Draft MR to main, no merge/deploy.

## Observable acceptance

1. Browser tab advertises same new branded PNG via an explicit favicon link.
2. Sidebar (authenticated), auth setup/login, and initial loading show the same recognizable icon, in both light and dark themes.
3. Existing page title, text, navigation and auth function remain unchanged.
4. Missing icon must not introduce broken image links; static asset is bundled under Vite `public/`.

## Plan and status

- [01-install-brand-icon.md](./01-install-brand-icon.md)
- `gate_version=2.2`
- Phase 01 state: `not_started` (initial)
- Validation commands from repo: `bun run --cwd apps/web build`, `bun run --cwd apps/web typecheck`, `bun test`.
- Effective CI: `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` (GitHub Actions bridge, actual provider jobs must be inspected separately).
- No verified local Bun checkout at plan time; evidence is recorded honestly, not inferred.

## Risks and rollback

- Favicon caches can retain an older image; use a versioned URL query if needed.
- For small icons, reduce to a clean centered circle and preserve the supplied colors/letter P.
- Revert this feature branch or omit merge; no database or migration changes.
