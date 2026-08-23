# Product-first comparison target

## Problem

Starter reports currently discover and investigate a broad competitor-company pool before the report knows which product comparisons will be published. A MyJam Starter run searched 200 primary-product anchors and repeatedly carried 167–189 competitor domains even after matching had produced 20 priced pairs. The oversized company graph then failed the public snapshot budget and a retry repeated paid discovery.

The customer-facing unit is a priced product comparison, not a catalog item or a discovered company. Starter therefore needs 20 accepted primary-to-rival product pairs. Multiple distinct rival products for one primary product each count as a comparison.

## Required behavior

- Process primary products in stable order through narrowly bounded product-search batches.
- Treat returned sellers as unverified product leads, not report competitors.
- Require an attributable first-party rival product page, a finite positive supported-currency price, compatible market evidence, and the existing semantic identity gate.
- Count unique accepted `(primary product, rival domain, rival product)` pairs.
- Stop product search and candidate verification as soon as the Starter target of 20 pairs is reached.
- Do not run broad entity/category competitor discovery for the ecommerce product-first path.
- Derive customer-visible competitor domains, company blocks, ads, relational company facts, and rival catalogs only from domains represented by the final published pairs.
- Preserve the 20 source-linked pairs and explicit omitted-domain counts in the compact public presentation.
- If fewer than 20 pairs survive the bounded product-search universe, publish the honest shortfall and coverage state; never fabricate or weaken price, market, or identity gates.
- On task retry, reuse a durable target-complete crawl/match checkpoint. A presentation persistence failure must not trigger another paid product search.

## Cost boundary

- Validate with deterministic fixtures and mocked providers first.
- Do not launch Growth or Agency reports.
- After review, merge, and deployment, run exactly one MyJam Starter acceptance report.
- Stop after that single paid proof and report the observed search/matching costs when available.

## Implementation

- The ecommerce crawl receives the remaining comparison-pair quota from orchestration.
- Each discovery wave searches at most 10 stable primary-product anchors and skips the entity and category company lanes.
- Candidate pages are verified in deterministic batches of four. Each batch is filtered through the same price, market, freshness, and identity boundary used for publication; investigation stops when the remaining pair target is met.
- The crawl publishes at most the requested number of pair hints and projects rival catalogs, company blocks, and ad targets only from the domains represented by those hints.
- Trigger contract v5 recovers a durable published-pair checkpoint before scheduling another crawl. A checkpoint with all 20 pairs suppresses both another crawl and another matcher call; legacy contract behavior is unchanged.
- The report competitor tab derives its domain list from accepted priced comparison rows. A seller represented by several accepted comparisons appears once in the competitor list with its accepted-comparison count.

## Fable pre-implementation review

The verified Fable 5 session identified retry amplification, unconditional company-search lanes, anchor-set drift, a weaker crawl gate than the publication gate, nondeterministic stopping risk, and company blocks not being tied to final pairs. The implementation addresses these with pre-crawl target recovery, comparison-only lanes, explicit anchor-hash failure, publication-gate parity, ordered batches, and pair-derived company projection. Exact-head review remains required before merge.

## Validation

- Product search runs in stable small batches and never invokes company lanes for ecommerce.
- Multiple rival pairs for one primary count independently.
- Candidate verification and further search stop at exactly 20 unique pairs.
- Duplicate pair identities do not inflate the target.
- Final company/domain projection contains only domains represented by the published pair set.
- A 20-pair document remains below the terminal presentation budget even when the input contains a large provisional candidate graph.
- A retry after a durable 20-pair checkpoint does not invoke crawl/discovery or paid matching again.
- Focused tests, typechecks, lint, VPS build, and the full test suite pass.
- Strict verified Fable 5 exact-head review reports PASS before merge.

Local results on the implementation branch:

- `npm.cmd run typecheck`: pass.
- `npm.cmd run typecheck:node`: pass.
- `npm.cmd run lint`: pass with two pre-existing `no-img-element` warnings and no errors.
- `npm.cmd run build`: pass.
- `node --test --test-reporter=dot tests/*.test.mjs`: 1,109 tests pass.
- Focused discovery, route policy, report projection, and retry tests: pass.

## Data boundaries

- Search output is an untrusted lead until first-party page, price, market, and semantic verification pass.
- Public-source observations, model inferences, and recommendations remain distinct.
- No fixture or inferred candidate is presented as a live competitor.
- No credentials, provider payloads, or customer-private data are stored in source or PR notes.
