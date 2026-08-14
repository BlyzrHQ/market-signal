# Task 129 — Wearform competitor recall

## Outcome

Prevent one weak ecommerce product-search lead from suppressing broader
competitor discovery, and keep promotional shipping/setup copy out of the
inferred market category.

## Production evidence

The Wearform report `b5911b3bf1b24d17bf850e43c5c2fb8d` collected 753
first-party products, 84 observed prices, and images for all 753 products. A
single product-search lead pointed to Grainger, whose homepage returned HTTP
403. Because any product candidate suppressed the entity and category lanes,
no other company was investigated, no competitor passed verification, and no
product comparison could run.

The category was also inferred as `Free Shipping & No Set-up Charge –
WearForm.com`, which is promotional copy rather than the observed category
`Custom Work Uniforms with Logo`.

## Scope

- Exclude shipping, setup-fee, discount, and similar promotional title clauses
  when a more descriptive title clause is available.
- Keep ecommerce product search, entity search, and category search bounded.
- Merge their candidates before the six-company investigation cap instead of
  treating the first product lead as proof that broader discovery is needless.
- Preserve independent first-party crawl, category, region, and product-overlap
  verification. Search output alone never becomes a published competitor.

## Acceptance criteria

1. A Wearform-like title resolves to `Custom Work Uniforms with Logo`.
2. Ecommerce company/category lanes still run when product search returns a
   candidate.
3. Product-backed candidates remain ranked ahead of company-only candidates.
4. Candidate investigation remains capped at six and ecommerce inclusion still
   requires current first-party product overlap.
5. Focused tests, full tests/build/typechecks, lint, and whitespace checks pass.
6. A fresh public Wearform report verifies at least one defensible competitor
   and publishes only price-backed product comparisons, or exposes the exact
   remaining public-access blocker.

## Review state

- Verified `claude-fable-5` review was attempted, but the CLI produced no
  judgment before the bounded timeout. No Fable PASS is claimed.
- Under the repository fallback rule, a Codex subagent returned PASS. It
  confirmed the six-search and six-investigation bounds and the unchanged
  independent verification gate. It identified the expected cost of two extra
  company searches per ecommerce report and a possible sequential-latency
  increase as non-blocking operational tradeoffs.
