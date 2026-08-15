# Task 143 — Canonical multilingual product price recovery

## Problem

The production `reefi.me` catalog contains English product names inferred from
public sitemap URLs, while the exact live product pages publish Arabic names,
images, and positive SAR offers. The selected-product enricher fetches those
same canonical pages but rejects the structured `Product` because the English
and Arabic names have no shared tokens. Prices that are visibly present on the
first-party page therefore remain missing from the report.

This is separate from competitor discovery. Report
`ea138c775a7c4ed281728abf4a0d41b2` also had zero verified competitors and zero
candidate pairs; Task 142 addresses recovery of bounded structured competitor
leads.

## Decision

Permit cross-script identity recovery only when the requested and fetched
records are first-party `Product` records on the exact same canonical product
page, the fetched structured name is strongly supported by the live page
title, and no quantity, GTIN, SKU, or MPN conflict exists. Keep ordinary
same-language repurposed-page rejection unchanged.

## Boundaries

- The rule is opt-in for exact selected-product enrichment; it is not a global
  product-matching shortcut.
- Require disjoint writing systems between the expected sitemap identity and
  the fetched structured identity.
- Require the fetched structured product identity to align strongly with the
  observed page title.
- Preserve finite positive amount and supported-currency filtering.
- Reject redirects to a different canonical product page and every hard
  identifier or quantity conflict.
- Preserve source URL, observed time, extraction type, and customer-visible
  data-quality gaps.

## Validation

- A Reefi-shaped English sitemap identity accepts the Arabic JSON-LD product,
  SAR 996 price, and secure image from the exact canonical page.
- Same-language page repurposing, title mismatch, URL mismatch, quantity
  conflict, and identifier conflict remain rejected.
- Focused route and product-intelligence tests, then full test/build/lint.
- Strict exact-head Fable 5 review, draft PR, merge by Fable after PASS.
- Deploy Trigger before the exact approved VPS commit.
- Run a fresh `reefi.me` production report and verify recovered primary prices,
  at least one verified rival, and at least one accepted comparison with a
  finite positive supported-currency rival price.

## Pre-review evidence

- Focused enrichment and product-intelligence tests: 95/95 passed.
- Full repository gate: 758/758 passed, including both typechecks and the
  production build.
- Lint: zero errors and two pre-existing `<img>` optimization warnings.
- `git diff --check`: passed.
- Real public `reefi.me` handler run: 2/2 pages fetched with zero gaps.
  `Awa Mattress` recovered the observed Arabic identity `مرتبة أوى الطبية` and
  SAR 996.00; `Awa Air Mattress` recovered `مرتبة أوى - الهوائية` and SAR
  396.00. Both remained JSON-LD observations on their requested source URLs.
