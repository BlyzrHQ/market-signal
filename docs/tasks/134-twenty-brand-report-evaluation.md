# Task 134 - Twenty-brand production report evaluation

## Goal

Measure how often the deployed Starter workflow produces a useful, truthful
competitive-product report across a broad ecommerce cohort. Wearform is the
known zero-result regression anchor. Failures and limited reports stay in the
sample; the matrix must not cherry-pick successful brands.

## Cohort

1. `wearform.com`
2. `myjam.co.uk`
3. `allbirds.com`
4. `gymshark.com`
5. `colourpop.com`
6. `beardbrand.com`
7. `deathwishcoffee.com`
8. `brooklinen.com`
9. `tentree.com`
10. `kotn.com`
11. `bombas.com`
12. `glossier.com`
13. `liquiddeath.com`
14. `buckmason.com`
15. `ruggable.com`
16. `hexclad.com`
17. `feastables.com`
18. `mejuri.com`
19. `warbyparker.com`
20. `ridge.com`

The cohort spans apparel, food and drink, beauty, homeware, jewelry, eyewear,
and accessories. It intentionally includes large Shopify catalogs, non-Shopify
sites, bot-protected storefronts, and a UK regional case.

## Execution

- Run the exact deployed production API at `https://signal.blyzr.com`.
- Request the normal public plan for every domain and record the plan persisted
  by the server. Nineteen domains are expected to use Starter (20 products);
  `myjam.co.uk` has a server-owned Agency entitlement and must be labeled as a
  plan outlier rather than misreported as Starter.
- Use at most three concurrent reports and a 20-minute terminal deadline per
  report.
- Persist a reduced JSON artifact after every state change so a partial run is
  auditable and resumable.
- Retain every live report URL and terminal status.
- Do not launch a separate paid agent evaluation for each report. The matrix is
  deterministic; two independent reviewers evaluate the completed aggregate.

## Mechanical and integrity metrics

- terminal status and runtime;
- total primary products discovered;
- verified competitors and synchronized competitor products;
- primary products assessed and accepted published matches;
- accepted matches with valid positive rival prices;
- direct price deltas;
- accepted-pair image-URL presence (not image loading or visual correctness);
- missing-price publication violations;
- source-link violations, suppressions, and persisted gaps.

## Evaluation

- **PASS:** terminal report, primary catalog, at least one verified competitor,
  at least one accepted rival-priced match, and no known publication-integrity
  violation. PASS measures useful substitute discovery; direct price-comparison
  availability is reported separately.
- **LIMITED:** terminal report remains truthful but has no verified competitor or
  no accepted priced match.
- **FAIL:** failed/stale run, an observed empty primary catalog for a visibly
  public store, or any known accepted comparison with an invalid/missing rival
  price, source, or conflicting product identity. A run with no saved report
  document has unknown catalog metrics, never an observed zero catalog.
- Three or more domains sharing the same limitation is a systemic product
  problem, not twenty isolated exceptions.

## Validation and review

- Verify the runner itself with focused tests and `git diff --check`.
- Check the Wearform fresh run separately after the price-recovery deployment.
- Persist reduced evidence for every accepted pair so findings remain auditable
  after the live reports expire. Human identity review is sampled, not exhaustive.
- Ask two independent reviewers to assess the aggregate for logical usefulness,
  recurring failure modes, and recommended engineering priorities.
- Record real observations only. Unknown values remain unknown, never zero.
