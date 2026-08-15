# Task 138 — First-party multilingual product aliases

## Problem

The fresh `noororganicfood.com` Starter report `db436ab30b4a48ba875a64009f00b412` collected 242 primary products but verified zero competitors and assessed zero product comparisons. Noor publishes the same first-party catalog under Arabic and English locale paths. Catalog deduplication correctly collapsed those URLs to one product identity, but discarded the English observed name, leaving search and verification dependent on Arabic/English lexical overlap.

## Decision

Preserve alternate first-party locale names as bounded, provenance-backed aliases on the canonical product. Use canonical and observed aliases for product search, candidate retrieval, product matching, and category verification. A shared validated GTIN may establish language-independent identity only when there is no quantity conflict.

Inferred or AI-translated text is not evidence and is not stored as an observed alias. Existing first-party crawl, same-brand, marketplace, publisher, regional, category, product-overlap, public-price, currency, and source-domain gates remain in force.

## Implementation

- Preserve at most eight same-domain sitemap aliases with name, normalized name, locale, source URL, and extraction method.
- Persist aliases in report facts and hydrate them from the database.
- Search and retrieve against canonical and observed alias names.
- Include observed aliases in deterministic entity verification without lowering thresholds.
- Retrieve and admit shared-GTIN pairs while preserving quantity and contradiction vetoes.

## Validation

- Focused tests cover locale sitemap merging, cross-language alias retrieval/matching, GTIN retrieval, quantity conflicts, discovery, verification, and fact persistence.
- Full test, typecheck, production build, and lint must pass.
- Strict verified Fable 5 review must return PASS on the exact PR head.
- Deploy Trigger before the VPS exact approved commit.
- A fresh Noor report must produce at least one verified competitor and at least one published comparison with a finite positive supported-currency rival price. If it does not, this recovery remains incomplete and the observed failure is recorded.
