# Task 040 — Babanuj primary product enrichment

## Outcome

Recover authoritative price, image, name, and quantity evidence from the exact first-party product pages selected for comparison, while continuing to reject genuinely repurposed product URLs.

## Real-data defect

- `babanuj.com` sitemap record: `zaitoune sweets pistachio maamoul 500g`
- Exact live product page: `Zaitoune Mamoul With Pistachio 500g`
- Live evidence observed on 2026-07-18: USD 43.20 and a Shopify CDN product image
- Existing result: the validator rejected the harmless title drift, leaving the primary comparison card without a price or image.

## Acceptance criteria

- Accept harmless first-party naming drift only when the canonical final page URL is the same selected product URL.
- Require at least two approximately aligned non-generic identity tokens and at least 50% coverage on both names.
- Keep short-token matching exact except for an exact four-or-more-character singular/plural suffix; typo fuzziness is limited to tokens of five or more characters.
- Reject conflicting GTIN, SKU, MPN, or canonical quantity evidence.
- Reject same-URL product/variant repurposing when both names retain different unmatched identity terms.
- Promote the fetched live name, price, image, identifiers, and quantity into the selected comparison record.
- Canonicalize the accepted final URL again at merge time and prefer the most specific accepted Product node when a page exposes several.
- Cover the Babanuj success case and repurposed/variant failure cases with tests.
- Validate against the real Babanuj page before completion.

## Data boundary

Only public first-party product pages are used. A stale sitemap label is not treated as live truth when the fetched structured product record is accepted; the current structured name becomes authoritative.

## Review

Fable 5 reviewed the proposed fallback before implementation and blocked a broad same-URL rule. This task incorporates its required token, identifier, quantity, redirect, and variant-conflict guards.
