# Task 009: bounded deep crawl and JSON report

## Goal

Replace the shallow homepage-only search experience with a real, bounded public-site crawl and a JSON-rendered evidence report. The first visible result should show what was fetched, which pages were covered, what claims were observed, and where coverage is missing.

## Implemented scope

- Crawl up to 4 submitted domains in one request.
- Crawl up to 5 HTML pages per domain, with a 1.5 MB document cap and a 6-second request timeout.
- Read `robots.txt`, honor disallow rules conservatively, read advertised sitemaps, and expand only through observed same-origin links or sitemap URLs.
- Reject private/local addresses and reject redirects that leave the submitted host.
- Deduplicate pages by final URL and SHA-256 content hash.
- Return per-page title, description, headings, price patterns, social links, language, inferred region, word count, timestamp, and capped claim text.
- Surface access failures, robots restrictions, non-HTML pages, and empty discovery as visible JSON report gaps.
- Label link-derived market candidates as `Inferred` / `Low` confidence and “possible match, not a confirmed competitor.” No model-generated competitor list is presented as fact.
- Render the server-produced JSON document as summary, coverage, company, candidate, evidence, and gap blocks in the UI.
- Keep the existing standard-model market brief separate from the deep JSON report; the brief remains grounded in its own fetched evidence until the next task connects it to the deep claim ledger.
- Make the repository build/test scripts work on Windows as well as Unix shells.

## Data boundaries

This is request-scoped evidence, not durable monitoring yet. It does not claim to discover every competitor, collect ad-library records, estimate spend, or prove market movement. Those require dedicated search, Meta/Google/TikTok adapters, historical snapshots, persistence, and scheduled recrawls. Raw HTML is not returned as a claim; source URLs, timestamps, content hashes, and capped snippets are used instead.

## Validation

- `npm.cmd test` — passed build and rendered-HTML tests.
- `npm.cmd run lint` — passed.
- Live local `/api/crawl` check with `stripe.com` and a failing comparison domain — returned the live primary result, honest page coverage, and a visible failure gap.
- Fable 5 strict review — PASS, no blockers. The review confirmed the domain propagation fix, off-site redirect protection, observed-path expansion, URL/hash deduplication, preserved partial failures, evidence-gated candidate labels, and live endpoint behavior.
- Fable 5 hardening re-review — PASS, no blockers. The follow-up caught and verified fixes for canonical `www`/apex host matching, self-candidate suppression, wildcard robots rules, and complete claim-ID resolution. Live checks returned `www.nytimes.com` as canonical `nytimes.com` with 5 requested / 4 fetched pages and zero candidates; `stripe.com` returned 5 requested / 2 fetched pages with honest gaps.

## Known next steps

- Move shared domain helpers into a library module instead of importing across route files.
- Persist a durable claim ledger in D1/R2 with content-hash change detection.
- Add search/co-occurrence and official ad-library adapters for broader competitor discovery.
- Connect the standard-model brief to deep claims only through validated claim IDs.
- Consider an eTLD+1/subdomain guard and a stricter navigation-context heuristic before broad content-site crawling.
