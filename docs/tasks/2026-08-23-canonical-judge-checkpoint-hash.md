# Canonical judge checkpoint hash

## Problem

The first production MyJam pair-contract pilot completed 185 durable AI judge
batches with 4,598 assessments, including 894 positive same-product or
close-substitute judgments. The report nevertheless recovered zero accepted
edges and terminally failed.

Production checkpoint inspection showed that every persisted judge checkpoint
failed its own batch-hash validation. The checkpoint store canonicalizes JSON by
sorting nested object keys. `safeProduct` embedded the quantity object directly
in the hash payload, so parser order (`kind`, `amount`, `unit`) became storage
order (`amount`, `kind`, `unit`) on reload. The evidence was intact, but its hash
could no longer be reproduced.

## Change

- Reconstruct canonical product quantity with an explicit stable field order
  before judge-batch hashing.
- Preserve compatibility with existing v4 checkpoints because the explicit
  order matches the parser's original quantity construction order.
- Add a regression that creates priced 500 g accepted pairs, applies the same
  recursive key sorting as persistent storage, and reconstructs every edge from
  the stored checkpoint.

## Boundaries

- This change does not weaken product identity, assessment completeness,
  confidence, market, price, or publication validation.
- It does not mutate the failed customer-visible report or replay paid calls.
- A fresh real-domain report is required after review, merge, Trigger-first
  deployment, and exact VPS deployment verification.

## Validation

- Focused AI-product-matching suite: 48/48 passed.
- Full suite: 1,096/1,096 passed.
- Browser and Node typechecks passed.
- Production build passed.
- ESLint passed with zero errors and two pre-existing `<img>` warnings.
- Read-only production replay of the failed MyJam checkpoints reconstructs 560
  accepted pairs across 296 historical product identities. Against the latest
  exact crawl identity, 32 pairs across 16 products remain eligible for safe
  recovery—more than the Starter target of 20.

Exact-head Fable 5 review, deployment verification, and one fresh Starter
MyJam report remain pending. Solo, Growth, and Agency examples remain blocked
until Starter reaches a truthful terminal report with 20 priced comparison
pairs.
