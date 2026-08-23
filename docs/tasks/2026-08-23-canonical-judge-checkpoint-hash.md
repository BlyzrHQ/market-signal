# Canonical judge checkpoint hash

## Problem

The first production MyJam pair-contract pilot completed 185 durable AI judge
batches with 4,598 assessments, including 894 positive same-product or
close-substitute judgments. The report nevertheless recovered zero accepted
edges and terminally failed.

Production checkpoint inspection showed that every persisted judge checkpoint
failed its own batch-hash validation. The checkpoint store canonicalizes JSON by
sorting nested object keys. Three durable identities embedded insertion-ordered
objects directly: the judge product quantity, candidate-plan groups and product
quantities, and the recovery catalog quantity. Parser order (`kind`, `amount`,
`unit`) became storage order (`amount`, `kind`, `unit`) on reload. The evidence
was intact, but the hashes could no longer be reproduced or adopted.

## Change

- Reconstruct canonical product quantity with an explicit stable field order
  before judge-batch hashing, candidate-plan identity, and recovery filtering.
- Reconstruct candidate-plan groups in their original field order before
  hashing so existing version-3 plan hashes survive storage canonicalization.
- Preserve compatibility with existing judge checkpoint versions 1 and 2
  because the explicit order matches the parser's original construction order.
- Add a regression that creates priced 500 g accepted pairs, applies the same
  recursive key sorting as persistent storage, and reconstructs every edge from
  the stored checkpoint.
- Make candidate-plan retry and recovery-catalog tests use the same recursive
  key sorting as persistent storage.

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
- Read-only production replay of the failed MyJam judge checkpoints reconstructs
  560 accepted pairs across 296 historical product identities. A post-deployment
  recovery must still verify how many exact current-catalog, priced pairs survive
  every production publication gate before any result is called successful.

Exact-head Fable 5 review, deployment verification, and one fresh Starter
MyJam report remain pending. Solo, Growth, and Agency examples remain blocked
until Starter reaches a truthful terminal report with 20 priced comparison
pairs.
