# Phase 01 — Install supplied P icon

- `gate_version=2.2`; initial `state=not_started`.
- **User-visible outcome:** browser tab and in-app brand locations show the user's chosen artwork.
- **Input:** the provided 1254×1254 RGBA logo PNG; existing tab title stays MediaVault.
- **Owner files:** `apps/web/index.html`; `apps/web/public/brand-icon.png` (new); `apps/web/src/components/BrandMark.tsx` (new); `apps/web/src/components/Sidebar.tsx`; `apps/web/src/pages/AuthPages.tsx`; `apps/web/src/App.tsx`.
- **Boundary:** static image under Vite public root `/brand-icon.png`, not an API/network call; sized via an image component, decorative empty alt because adjacent visible brand text already conveys the app identity.
- **Prerequisites:** use a new feature branch based on the pinned main SHA; do not mutate protected main.
- **Implementation microsteps:**
  1. Inspect and clean outside-circle transparency in uploaded art, scale to a PNG icon suitable for Vite without introducing a modified logo design.
  2. Add a regression test checking the served favicon URL/static brand file and source references; observe its RED result if an executable checkout is available.
  3. Add static asset and explicit `rel="icon"` (and `apple-touch-icon`) links in HTML.
  4. Add reusable `BrandMark` and replace the old `Aperture` icon at sidebar/auth/loading identity sites, leaving other pictograms unchanged.
  5. Confirm appropriate `width`/`height`, `alt`, transparent edges, no tiny blur/stray pixels, and no changes to title/body copy.
  6. Run observed precommit tests/typecheck/build where possible, inspect source diff, commit implementation.
  7. Resolve exact code commit SHA/provider CI job evidence. Separately review requirement coverage and asset/path/accessibility/performance/security. Document blockers as unverified.
  8. Open Draft MR. No merge/deploy.
- **Failure/negative:** static asset 404 on nested route, broken icon after browser reload, transparent outside showing stray artifacts, missing text alternative, icon unreadable on dark backgrounds.
- **Rollback:** revert only visual and HTML references plus new static image and test.
- **Outcome integration proof:** actual served browser tab/React screens after build/deploy; unavailable browser E2E remains unverified.
- **No fabricated evidence:** `implemented`, `tested`, `verified`, and `completed` are independent gates. CI dispatch is not job execution.
