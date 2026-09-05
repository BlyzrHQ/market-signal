# Rival breadth and currency recovery

Branch: `codex/rival-currency-recovery`, based on PR #229 / 17ae98b.

## User request and acceptance

Remove the default five-rival restriction: a 20-comparison report may contain
20 different rival sellers. Recover attributable currency when the visible
price omits it. Validate on new public domains, with no more than USD 50 in
provider credits for this task. Do not spend the ceiling merely because it is
available. The existing website remains unchanged; use pinned Trigger workers.

Preserve finite positive prices, source identities, robots/market boundaries,
and explicit uncertainty. A country-code domain or dollar symbol alone does
not establish a currency. Do not fabricate currency to fill a report.

## Working plan

1. Inspect saved evidence and real script-only storefront probes.
2. Make the default seller allowance follow the comparison target; preserve
   explicitly requested narrower caps and old persisted request identities.
3. Recover currency from attributable storefront evidence, refusing conflicts.
4. Test isolated units and the real workflow; strict Fable review before a
   pinned test deployment. No merge or production promotion without acceptance.
5. Run a small sequential batch on new domains, recording each run, coverage,
   elapsed time, and provider usage. Stop on unknown cost or budget risk.

## Budget

New authorization: maximum **USD 50** provider credits for this task. Prior
tasks' expenses are not part of this new budget. No paid report launched yet.
Use a dedicated external execution ledger with request/run IDs and conservative
usage estimates; never store credentials. Reserve headroom before each run.
Unknown charges are not zero. Test data is never presented as live report data.

## Evidence and review

Script-only public probes found geo-dependent currency: the Tea House Mao Feng
page had GBP metadata but EGP runtime and an EGP 597.00 adapter price from Egypt.
Requesting the same product with `?currency=GBP` yielded GBP/GB runtime and a
GBP 8.50 product price. The actual enrichment now returns GBP 8.50 with that
source URL, one page fetched, no gaps, in 1.95 seconds. No AI charge for the probe.
This is one observed product, not proof of universal recovery or report quality.

Fable 5 architecture reviews: sessions 7d9cdb23-283f-4a48-9975-3894b0ca9920
and 88c011f7-ef15-4d27-aec2-991660776bde, canonical claude-fable-5-1.
A separate review hit max-turns (not capacity, not PASS). The completed review
required independent page amount agreement before trusting query-selected .js
amounts. Implemented that condition; no currency is inferred from the query
itself, TLD, FX conversion, or an ambiguous currency symbol. The selected URL
remains the evidence URL. Existing explicit market/locale selectors are kept.
Review was subscription-backed; list-price token estimates are not report API
spend. Exact-head implementation review and pinned deployment remain pending.
