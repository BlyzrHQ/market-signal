# Task 141: source-first multilingual product verification

## Problem

Product search can return an attributable first-party product-detail page whose locale, opaque SKU, or translated slug shares too few lexical tokens with the primary product. The current pre-crawl URL matcher rejects that source, so multilingual stores can finish with zero investigated sellers even though the downstream exact-page verifier is capable of rejecting false matches safely.

## Scope

- Admit a bounded number of query-attributed, explicit first-party product-detail sources as private investigation leads when lexical URL matching is inconclusive.
- Keep citation-only links, listing/search/category pages, marketplaces, the primary brand, and unsafe URLs excluded.
- Preserve the existing publication gate: exact requested page (or identity-preserving same-domain redirect), one first-party structured Product identity, finite positive supported-currency price, regional compatibility, and a targeted semantic verdict of `same_product` or `close_substitute` at confidence >= 0.8 with no contradictions.
- Do not publish provisional source claims when verification fails.
- Reserve the global investigation budget so source-first leads cannot displace all attributable candidates, and remove private lead details from the returned discovery snapshot.

## Validation

- Regression coverage for opaque/SKU and cross-script source-first leads.
- Regression coverage that citation-only and listing routes are not source-first admitted.
- Existing exact-page, price, identity, redirect, region, and semantic rejection tests remain green.
- Full typechecks, production build, test suite, and lint.
- Strict exact-head Fable 5 review before merge.
- Deploy Trigger before the VPS exact approved commit.
- Fresh `noororganicfood.com` live report must include at least one verified rival and one product comparison with a finite positive supported-currency rival price before the 20-site evaluation matrix begins.

## Data boundaries

Search output is only a discovery hint. A source-first lead is not customer-facing evidence and cannot establish a competitor, product identity, or price. Only the independently crawled first-party page and the downstream verification result can be published.
