# Phase 01 — poda identity and favicon

## Expected externally observable behavior
- Fresh and returning user at / sees supplied logo and the name poda on splash, login/setup, and sidebar.
- Browser's tab uses the supplied circular icon and displays `poda`, including after refresh/deep link.
- Old localStorage theme and session settings survive; existing Docker media and data volumes remain mounted under original technical identifiers.

## Source touchpoints
`apps/web/index.html`, `apps/web/public/poda-icon.png`, `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/pages/AuthPages.tsx`, `README.md`, relevant branding-only headings. Prefer shared `BrandLogo` component for consistent styling.

## RED / GREEN / test steps
1. Add a focused branding source/asset test (Bun) ensuring the entry HTML title/favicon, logo file and visible screens name poda.
2. Run `bun test <branding-test-path>` and capture the expected failing brand check if real executor exists. Otherwise mark RED not executed.
3. Replace user-facing text and icon components, add PNG, then check test; `bun run --cwd apps/web build` and `bun run typecheck`.
4. Review diff for runtime identifier changes and broken link paths. GitLab actual CI is external GitHub Actions via bridge; verify matched SHA provider job logs if accessible.
5. Open Draft MR for review; no merge, production deploy, or GitLab project metadata rename without separate permissions/tools.

## Risks and negative cases
- Vite requires static PNG under `apps/web/public`, referenced as `/poda-icon.png`; a missing asset yields 404.
- Renaming `mediavault-data` Docker volume can hide existing media metadata: forbidden.
- Renaming `mediavault.themeMode` localStorage key resets themes: forbidden.
- CSS must keep icon circular and visible in light/ash/dark/onyx themes.
- Existing docs/code identifiers are valid historical identifiers; changing them globally is unsafe.

## Evidence and checkpoint
- Code candidate: `25b468d6a6a4ef3b486b25336a6e4e4ad46a5de8` (feature changes; docs-only follow-up SHA is not code test evidence).
- GitLab diff: 13 changed paths in Draft MR !19; source checks confirm active branding has no literal `MediaVault` or `Pmanager` in 53 TSX files.
- The approved PNG's 4747-byte repository blob SHA-256 matches the locally converted logo (`392c0589127bedfb5a8e036ceeb60217d141027f77772ef2fa798b01d75079b4`).
- Static code self-check: favicon link maps to `public/poda-icon.png`; logo component used in splash/sidebar/auth; localStorage theme key untouched.
- Authored `apps/web/src/branding.test.ts`. Bun RED/GREEN tests, typecheck, build and browser E2E: **not executed**, so no pass claim.
- GitLab bridge pipeline 3098983803 for exact code SHA reports GitHub Actions dispatch success; provider `github-actions/ci-hub-request` subsequently reported **success** for the exact candidate code SHA (https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44990318103), but actual jobs, command logs and checkout SHA were **not independently verified**.
- State: **implemented; blocked from verified/completed** by missing job and user-flow E2E proof. No merge or deploy.
