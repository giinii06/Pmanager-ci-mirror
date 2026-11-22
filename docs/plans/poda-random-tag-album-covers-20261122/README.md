# poda — random tag sorting and ephemeral covers

Target: GitLab `blond11qq/Pmanager`, branch `feature/poda-branding-20261122`, resumed from `f07b05e2ec52bbb06c40cd7e839c8566c351547e`, existing Draft MR !19.
CI provider: effective GitLab config `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` bridging to GitHub Actions; exact SHA jobs and browser E2E require separate inspection.
`gate_version=2.2`.

## Agreed visible behavior
1. Both photo and video **tag overview** pages offer 랜덤순 / 조회수순 / Vote순 / 이름순 / 날짜순, matching the supplied screenshot. Initial mode is 랜덤순; sorting the folder/tag cards does not affect inside-tag media sorting.
2. Tag cover is one eligible, nondeleted tagged asset selected randomly **on each opening of the overview screen**. The same selection remains stable during interactions in that mounted screen.
3. Photo album card cover is one randomly selected nondeleted direct photo **on each browser reload** (new GET /api/folders response); existing tag and album images remain unchanged.
4. Remove all visible “썸네일로” cover-pinning buttons from the photo viewer. Preserve existing DB schema and legacy cover API for compatibility (no destructive migration).
5. Empty tags/albums show their existing fallback. One-item collections show their only image. Random selection can coincidentally repeat.

## Derived semantics
Tag overview 조회수순/Vote순 order by sum of belonging eligible assets’ view_count/vote_count; date is tag creation time; names are Korean-case-aware collated. Photo and video tags stay separate and counts never mix kinds.

## Implementation phase
[Phase 01 — one user-visible overview and card cover behavior slice](./phase-01-tag-and-album-covers.md).
This task extends the existing Draft MR !19; no merge, deployment or repository rename.

## CI repair diagnostics (2026-11-22)
[CI failure investigation and operator evidence capture](./ci-failure-diagnostics.md). Both the original code-SHA run and a no-code-change rerun failed; no job-level log access was available in this session. The phase remains implemented, not tested/verified.
