# Phase 02 — verification and review

State: not_started. Blocked on Phase 01 proof.

1. On exact candidate SHA inspect effective GitLab CI config and pipeline provider; dispatch only the configured GitHub Actions bridge if needed.
2. Confirm actual tests/typecheck/build output and checked-out SHA from provider jobs; GitLab bridge success by itself is only dispatch.
3. Browser positive and negative flows: open a video and inspect thumbnail dimensions; navigate to video tags and confirm justified coverage with mixed ratios and responsive resize; open tag contents and confirm media selection; inspect photo tag overview for no regression; keyboard navigation; no covers.
4. Review actual `BASE_SHA..HEAD_SHA` in two lenses (requirements + quality/security). This may be sequential self-review only; never label independent.
5. Record verified SHA and test/E2E evidence or explicit blocked reason. Draft MR only; no merge/deploy.
