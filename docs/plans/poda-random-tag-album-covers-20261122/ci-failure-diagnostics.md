# CI diagnostics — poda tag sort & random covers

## Scope and evidence
- Project: GitLab `blond11qq/Pmanager` / Draft MR !19 / branch `feature/poda-branding-20261122`.
- Last feature code SHA: `dc355768bd517f237ee3e57ee4e87586e55e2e93`.
- Docs-only checkpoint tested by second bridge: `ef3498c4b08fb9f8a12c868a8fa17cef9d006196`.
- CI selector: effective GitLab external config `.gitlab/ci-hub-request.yml@blond11qq/ci-hub-smoke` sends GitHub Actions. **Do not** enable GitLab-hosted Runner or reconfigure mirroring to mask the failure.

## Timeline / classifications
| Observation | Source SHA | GitLab pipeline | GitHub Actions | Dispatch | Provider callback | Job log/check-out SHA |
|---|---|---|---|---|---|---|
| Before feature, branding control | `25b468d6a6a4ef3b486b25336a6e4e4ad46a5de8` | 3098983803 | [44990318103](https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44990318103) | success | success | unknown |
| First new-feature build | `dc355768bd517f237ee3e57ee4e87586e55e2e93` | 3099032604 | [44992687882](https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44992687882) | success | **failed** | unknown |
| Unmodified code retry (docs-only HEAD) | `ef3498c4b08fb9f8a12c868a8fa17cef9d006196` | 3099047910 | [44993554908](https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44993554908) | success | **failed** | unknown |

The first two feature runs do **not** show an actual failed test step to this connector. Failed callback alone could indicate checkout/mirroring, setup, type checking, tests, environment or build. Do not choose a patch without the earliest actual error.

## Controlled checks performed (not equivalent to full CI)
1. GitLab original files read at exact candidate code SHA. Compared affected import/DTO/sql paths. No conclusive causal defect found by static review.
2. Isolated `packages/database/src/tags.ts` SQL logic recreated in Python `sqlite3` memory DB with photo/video and deleted assets; 30 iterations passed kind separation, sums and eligible cover selection. Album cover random SQL: 30 iterations passed direct folder isolation and deleted exclusion. This checks SQLite query semantics, not Bun DB integration.
3. Source `apps/web/src/lib/tagSort.ts` copied verbatim to local temporary module with only minimal type stub and compiled with global `tsc`; six Node assertions passed for random stability, deterministic categories and nonmutating input. Full Vite/React/Bun build **not run**.
4. GitHub Actions run page and jobs API were inaccessible through the available web tool; browser tab connector unavailable without originating browser extension; container cannot resolve GitLab host for `git clone`; Bun executable unavailable. Actual GitHub job logs/check-out commit remain unknown.

## Minimal next evidence required
From an authenticated computer with GitHub CLI access to the mirror, capture the *failed step* (redact tokens/paths as needed):

```bash
gh run view 44993554908 -R giinii06/Pmanager-ci-mirror --log-failed
```

If the command returns empty, inspect metadata and jobs first:

```bash
gh run view 44993554908 -R giinii06/Pmanager-ci-mirror --json status,conclusion,jobs,headSha
```

Check whether the checkout SHA in the actual job is the GitLab branch HEAD expected for that pipeline and the first failing step. Only then apply a minimal regression-tested change and rerun effective CI on a matching SHA.

## Outcome
**Blocked: code not modified in CI repair investigation; two external provider runs failed.** Keep MR Draft, no merge or deploy. Missing job traces prevent an evidence-backed fix. A third speculative corrective commit is not justified.


## Confirmed root cause and single corrective patch
The previous "root cause unknown" state above is superseded by the user-supplied full failed-job log for run 44993554908.

The trace explicitly shows checkout of `ef3498c4b08fb9f8a12c868a8fa17cef9d006196`, then the first compile failure at `packages/database/src/random-covers.test.ts:77`: `TS2769` from passing nullable `photo.coverAssetId` into `toContain` with a `string` expectation. It was a **test type error**, not a failed random-cover assertion. Bun package install succeeded; test/build steps were skipped due to typecheck exit code 2.

Exactly one source line was changed in corrective commit `b1772b2342e5cf128eafb0354322aad8677569db`. CI re-dispatched at [GitLab 3099052889](https://gitlab.com/blond11qq/Pmanager/-/pipelines/3099052889) and received a **successful GitHub Actions provider callback** from [run 44993844861](https://github.com/giinii06/Pmanager-ci-mirror/actions/runs/44993844861). Since the successful job's detailed logs are not accessible in this session, do not treat callback success as independently verified build/test categories. Browser E2E still missing. No further speculative changes needed for confirmed TS2769.
