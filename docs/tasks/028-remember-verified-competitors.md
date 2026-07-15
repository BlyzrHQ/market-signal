# Task 028 — Remember and re-verify competitors

## Outcome

Make domain-only competitor discovery cumulative instead of memoryless. Once a competitor has passed live entity verification for a primary domain, later reports should remember that candidate, re-crawl it, and require it to pass the same live verification gate before it can appear again.

## Why this task exists

Task 027 made incomplete product matching visible but production MyJam runs still varied from 13 to 116 to 410 rival catalog products because every run forgot previously verified competitors. The same matcher returned useful results when discovery happened to include a deep comparable catalog and almost none when it did not.

## Scope

- Add a D1 `verified_competitors` table keyed by canonical primary and competitor domains.
- Persist only competitors that passed current first-party entity verification.
- On later runs, load up to three recent remembered candidates and merge them with fresh discovery while retaining the six-candidate investigation cap.
- Re-crawl and re-verify every remembered candidate live. Stored data is a lead, never current competitor evidence.
- Delete a remembered lead when its current crawl or entity verification fails, and expose the dropped re-verification as a report gap.
- Label accepted competitors as `discovered-this-run` or `remembered-reverified`, including the remembered verification date.
- Age remembered leads out after 30 days without successful re-verification.
- Keep persistence failures honest and non-fatal: fresh discovery still runs and the report records a memory coverage gap.

## Non-goals

- No hardcoded competitor domains.
- No persisted product, price, ad, or match evidence.
- No relaxed entity or product matching thresholds.
- No extra model calls, match-count retries, or more than six candidate investigations per report.

## Acceptance criteria

1. Memory is isolated by canonical primary domain and deduplicated by competitor domain.
2. Remembered candidates consume existing investigation slots; total candidate crawls remain capped at six.
3. A remembered candidate is rendered only after a current crawl and the existing entity verification gate pass.
4. A failed remembered re-verification is removed and appears only as a visible gap.
5. Every product pair continues to cite two current public source URLs; no product catalog is loaded from memory.
6. Tests cover merge priority, isolation, aging, malformed records, upsert/delete behavior, and provenance.
7. Generated D1 migrations, typecheck, build, lint, JavaScript tests, and both Go modules pass.
8. After one deployed MyJam run verifies a deep comparable catalog, two subsequent domain-only runs retain and re-verify it and expose at least five defensible visible comparisons when both current catalogs contain at least 100 products.
9. The in-app browser shows remembered/re-verified provenance and the final product comparison outcome.
10. Strict Fable 5 review passes; Fable merges the stacked PRs in dependency order only after deployment and browser QA.

## Architecture decision

Fable 5 returned `FABLE_TASK_027_LIVE_FAILURE`: persist verified competitor leads per primary domain, then re-crawl and re-verify them on every reuse. This preserves current-evidence boundaries while making monitoring cumulative.

## Evidence record

- Implemented D1-backed, primary-domain-scoped remembered competitor leads with a generated migration and a 30-day read TTL.
- Remembered leads are capped at three and share the existing six-candidate live crawl budget with fresh discovery.
- Every remembered lead is re-crawled and re-run through the unchanged entity verification gate; rejected leads are deleted and rendered as coverage gaps.
- D1 stores an explicit whitelist of discovery-lead fields only. Products, prices, ads, matches, provenance state, and verification-result objects are not serialized.
- UI labels accepted reused leads as `Remembered lead · re-verified live` in the threat map and rival dossier.
- Local gates: typecheck, production build, lint, 133 JavaScript tests, CLI Go tests, and contracts Go tests passed.
- Strict Fable 5 round 1: `FABLE_TASK_028_FAIL` because the first write path spread the full verification object and could persist proven product prices.
- Fix: replaced spread serialization with an explicit sanitized `DiscoveryCandidate` whitelist and added a regression test that injects forbidden product/price/verification data and proves it is absent from the D1 INSERT JSON.
- Strict Fable 5 round 2: `FABLE_TASK_028_PASS`.
- Follow-ups noted by Fable, not merge blockers: opportunistically delete expired rows; distinguish transient crawl failures from hard verification rejection before eviction; prefer fresh same-domain evidence when fresh and remembered leads collide.
- Deployment, repeated live MyJam validation, and in-app browser QA remain pending.
