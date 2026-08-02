# Task 092 — Recover product prices and images

## Problem

Real ecommerce reports still contain product rows without public prices or
images even when those fields are visible on the cited product page. This makes
the comparison feel incomplete and prevents useful price-position decisions.

## Scope

- Measure where product evidence is lost: URL discovery, robots handling,
  ordinary HTTP extraction, storefront endpoints, identity validation, or the
  bounded enrichment budget.
- Add the smallest terms-compliant first-party fallback that materially improves
  observed price and secure-image coverage without guessing values.
- Preserve product/source attribution, currency evidence, redirects, request
  limits, timeouts, and private-network protections.
- Expose an explicit gap when a public value cannot be verified.
- Validate the change against real ecommerce domains and record before/after
  product, price, and image counts.

## Acceptance criteria

1. A product price or image is stored only when observed on a first-party page
   or its same-domain public storefront endpoint.
2. Missing or unreadable robots.txt does not silently become a broad crawler
   bypass; explicit disallow rules remain authoritative.
3. Unit, integration, typecheck, build, and lint checks pass.
4. At least two real ecommerce domains show no regression, and at least one
   known incomplete report fixture or replay shows a measurable increase in
   verified price or secure-image coverage.
5. Strict Fable 5 review returns PASS before merge, followed by exact-revision
   deployment and live verification.

## Out of scope

- Invented prices, currency inference from region alone, or third-party images.
- Unbounded browser automation across complete catalogs.
- Product matching, ads intelligence, or dashboard redesign.

## Fable 5 decision

The verified Fable 5 session selected three bounded fixes after reviewing the
full extraction path: RFC-aligned handling for absent robots files, a measured
route-cap increase from 6+6 to 16+16, and exact three-decimal/Arabic currency
parsing. It rejected headless-browser crawling, third-party evidence, new store
adapters, region-based currency inference, and an immediate increase to the
24/64 ceilings. The existing JSON-LD, Open Graph, visible-markup, Shopify,
WooCommerce, identity, timeout, redirect, and concurrency controls remain.

The Shopify fixed-hundredths adapter was revalidated before retention. On
2026-08-02, two Noor Organic pages exposed structured KWD prices 3.350 and
2.990 while their same-domain `.js` variants returned 335 and 299. Two
BluePassion pages exposed KWD 2.93 and 1.80 while their `.js` variants returned
293 and 180. The observed pairs confirm this storefront contract for the real
test domains; region or ISO minor-unit inference is not used.

## Real-data validation

Replaying bounded enrichment against persisted first-party catalog records on
2026-08-02 produced the following before/after evidence. The baseline catalogs
contained secure images but almost no prices because only six selected pages
could be enriched.

- Noor Organic: first 16 targets, 16 fetched, 16 priced, 16 imaged (baseline
  catalog: 0/40 priced, 40/40 imaged).
- BluePassion: first 16 targets, 16 fetched, 16 priced, 16 imaged (baseline:
  0/40 priced, 40/40 imaged).
- Organic N More: first 16 targets, 10 identity-valid pages priced and imaged;
  six redirected to a generic storefront and remained rejected rather than
  being misattributed (baseline: 0/40 priced, 40/40 imaged).
- MyJam: first 16 missing-price targets, 16 fetched, 16 priced, 16 imaged
  (baseline: 2/40 priced, 40/40 imaged).
- My Meat Shop and Halal Fine Foods: 16/16 each fetched, priced, and imaged;
  FoodSouq: 10/10. Existing priced Oasis products produced no unnecessary
  targets.

Every recovered value came from the cited first-party page or its same-domain
public storefront endpoint. No third-party or region-inferred value was used.
