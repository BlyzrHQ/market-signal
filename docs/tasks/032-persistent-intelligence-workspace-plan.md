# Task 032 — Persistent intelligence workspace plan

## Product decision

Market Signal will become a persistent competitive-intelligence workspace rather than a one-page, one-time report. A submitted domain creates a durable report run, moves immediately to a dedicated progress route, records every completed phase in the Sites-managed D1 database, and ends on a dedicated report route with focused competitor, product, ad, evidence, and methodology views.

Sites D1 is the SQLite-compatible database for the deployed product. A local `.sqlite` file inside the serverless application would be ephemeral and must not be represented as durable storage.

## Problems to solve

- The light page sits inside a narrow canvas and leaves visually empty sides.
- Submission appears to pause without explaining crawling, discovery, matching, enrichment, or ad collection.
- Results remain on the landing page instead of becoming a durable, shareable report workspace.
- Report data is held only for the current browser lifecycle even though D1 currently remembers verified competitor leads.
- The report is long and difficult to scan; competitors, products, ads, and evidence compete for attention.
- Product matching still misses bilingual and identifier-backed matches and does not learn from previously verified product relationships.
- Success is measured on isolated examples instead of a repeatable five-domain human-usefulness benchmark.

## Approved experience architecture

1. `/` is a dark, full-width domain-entry surface with concise product proof.
2. Submission creates a durable run and routes to `/reports/{publicId}/loading`.
3. The loading view shows a small animated market radar plus factual phase messages sourced from persisted run events. It never invents progress percentages.
4. A completed run routes to `/reports/{publicId}`.
5. The report workspace uses a stable header and separate tabs for Overview, Competitors, Products, Ads, Evidence, and Methodology.
6. Tab state is deep-linkable through route/query state. Cards link to the relevant rival dossier, product comparison, ad evidence, and first-party source without scrolling the entire document.
7. A saved report can be reopened by its unguessable public id. Authentication and organization-level history remain a later product layer; no customer identity is inferred in the free acquisition flow.

## Approved persistence architecture

Task 033 will extend the existing D1 binding with relational, indexed records for:

- `report_runs`: domain, region/language, lifecycle state, timestamps, failure/coverage state, and public id;
- `report_events`: ordered factual progress events and phase timings;
- `report_companies`: the primary company and verified competitors with discovery/verification provenance;
- `report_products`: the observed product snapshot used by a run, including source, identifier, image, and public price fields;
- `report_matches`: accepted product relationships, verdict type, confidence, model/prompt version, and both source references;
- `report_ads`: advertiser/platform observations and explicit coverage states;
- `report_documents`: a versioned JSON snapshot used to reconstruct the current report UI without recrawling.

Run snapshots are historical observations, not automatically current facts. Every record keeps `observed_at`, source URLs, claim type, confidence, region, and language where applicable. A later monitoring run creates a new snapshot rather than silently rewriting history.

### Runtime and retention constraints

- The first implementation uses client-orchestrated, idempotent phases rather than claiming a multi-minute Worker request will continue forever after the browser closes. Each completed phase is committed before the next begins.
- A run records its current phase, heartbeat, attempt count, and last completed event. A stale active run becomes `interrupted`, remains reopenable, and can resume from the last safe phase without duplicating records.
- `report_documents` stores a bounded presentation snapshot and schema version, not every raw product record. Large catalogs, evidence, matches, and ads remain in relational tables and are reconstructed through bounded queries.
- Public report ids are cryptographically unguessable and no listing/enumeration endpoint is exposed in the free flow.
- Unauthenticated free reports use an explicit, configurable retention window with a 90-day default. Cleanup removes report-owned rows in bounded batches while retained aggregate benchmark metrics contain no customer-specific report payload.

## Approved product-matching direction

Fable 5 returned `FABLE_RESEARCH_DECISION: GO` after inspecting the current implementation and product-matching research.

The approved precision ladder is:

1. Normalize Arabic/English text, digits, pack units, and variant attributes deterministically.
2. Extract and validate GTIN, SKU, MPN, brand, size, quantity, and variant as first-class fields.
3. Treat a guarded shared valid GTIN as observed identifier evidence; keep other model decisions visibly inferred.
4. Retrieve candidates with multilingual text embeddings and per-rival candidate coverage.
5. Use the bounded small-model judge for final `same_product`, `close_substitute`, or rejection decisions.
6. Persist canonical product leads, content-hash embedding cache entries, and prior verdict leads in D1; require current-page re-verification before rendering them as current evidence.
7. Collect explicit confirm/reject feedback to create a labeled benchmark before considering fine-tuning or a model switch.

Image similarity is not approved as a core matching layer yet. Current grocery failures are dominated by identifiers, Arabic normalization, units, and retrieval starvation; SaaS and agency offerings often have no useful product image. A future image tie-breaker requires benchmark evidence that it improves a specific residual error class.

## Sequential tasks

### Task 033 — Durable report runs

Add the D1 schema, migrations, persistence helper, run/event/report APIs, lifecycle writes, report reconstruction, retention boundaries, and tests. Deploy and prove a real report survives reload before merge.

### Task 034 — Dark loading and report routes

Replace the constrained light presentation with a dark, full-width responsive system. Add the domain-entry, dedicated loading, and completed report routes. Progress text must come from Task 033 events. Test desktop, narrow desktop, mobile, English, Arabic, reload, and failure states.

### Task 035 — Tabbed intelligence workspace

Separate Overview, Competitors, Products, Ads, Evidence, and Methodology. Add deep links and cross-references between rivals, product pairs, ads, and sources. Prioritize decisions and comparisons over raw crawl fields.

### Task 036 — Bilingual identifier-first matching

Implement Arabic normalization, Arabic/English unit parsing, first-class identifiers, guarded deterministic identity evidence, and per-rival retrieval coverage. Preserve strict price and variant safety.

### Task 037 — Database-backed match memory

Add canonical product leads, content-hash embedding cache, current-evidence re-verification, match-history leads, and feedback capture. D1 remains the store; exact in-memory scoring remains the index while report catalogs stay small. Do not add Vectorize or an external vector database without benchmark evidence.

### Task 038 — Five-domain usefulness benchmark

Run repeated production tests across two bilingual grocery stores, one additional ecommerce catalog, one SaaS company, and one agency/service company. Have a human review every displayed pair and have Fable 5 independently score usefulness.

## Five-domain acceptance gate

- At least 95% of displayed `same_product` pairs and 90% of displayed `close_substitute` pairs are defensible in human review.
- Zero incorrect exact price deltas.
- Bilingual grocery domains show at least 1.5× the defensible comparison count of the current-master baseline on equivalent crawl snapshots, including at least five Arabic↔English pairs missed by the baseline.
- A low-overlap control remains honestly thin rather than gaining false matches.
- Three repeated runs vary in displayed pair count by no more than 20%, unless a visible source/verification gap explains the change.
- A repeated unchanged run achieves at least 60% embedding-cache hits without increasing the bounded judge-call budget.
- Every report records catalog depth, source/price/image coverage, accepted pairs, rejected/limited states, phase latency, model cost indicators, and the three most useful decisions a human can act on.
- The dark loading and tabbed report experience passes in-app browser QA at desktop and mobile widths in English and Arabic.

## Delivery rules

- Every implementation task starts from updated `master` and uses its own `codex/*` branch and task document.
- Each task runs its focused tests, full build/lint/typecheck, relevant Go tests, real-domain validation, and in-app browser QA.
- Each task is pushed to GitHub as a focused PR, reviewed strictly by the verified `claude-fable-5` model, deployed from the exact reviewed commit, and merged by Fable only after all gates pass.
- Tasks are sequential. A dependent task does not start until the previous PR is merged and `master` is updated.
- Fixture data is limited to labeled tests and scaffolding. No fixture result may appear as a live customer report.

## Research basis

- WDC Products benchmark: https://arxiv.org/abs/2301.09521
- Multilingual product matching: https://arxiv.org/abs/2205.15712
- Retail-786k visual entity matching: https://arxiv.org/abs/2309.17164
- GS1 trade-item identification: https://www.gs1.org/standards/gs1-global-traceability-standard/current-standard
- Schema.org GTIN: https://schema.org/gtin
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Cloudflare storage options: https://developers.cloudflare.com/workers/platform/storage-options/
- Cloudflare Vectorize: https://developers.cloudflare.com/vectorize/

## Task 032 acceptance

1. The persistence, routing, information architecture, matching method, and five-domain benchmark are decomposed into independently mergeable tasks.
2. D1 is explicitly selected as the deployed SQLite-compatible store; ephemeral local files are rejected.
3. Product evidence, inference, history, and current observations remain distinct.
4. Fable 5 strictly reviews this plan and returns PASS before merge.
5. The plan is published as a focused PR and merged before Task 033 begins.

## Review record

- Deep matching research: verified `claude-fable-5` session returned `FABLE_RESEARCH_DECISION: GO`. It approved identifier-first matching, bilingual normalization, bounded multilingual retrieval plus model judging, and D1-backed leads/caching. It rejected image AI and external vector infrastructure as current core dependencies.
- Strict plan review: verified `claude-fable-5` session returned `FABLE_TASK_032_PASS` with no merge blockers.
- The review's advisory findings were incorporated before publication: resumable client-orchestrated phases and interrupted-run handling; bounded presentation snapshots with relational reconstruction; unguessable ids and explicit free-report retention.
