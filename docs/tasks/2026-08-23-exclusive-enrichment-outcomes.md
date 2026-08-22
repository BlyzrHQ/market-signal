# Exclusive product-enrichment outcomes

## Problem

Production report `4d5bce140f124478b951ed1846ef2edf` found valid judged product pairs, but both enrichment batches were discarded. The enrichment endpoint could return one target as both a product and an unresolved adapter gap, while the durable checkpoint contract correctly requires exactly one outcome per target.

## Change

- Treat a product with an unresolved adapter price gap as a gap-only outcome so it can be retried safely.
- Preserve successful products from other targets in the same batch.
- Reject non-HTTP(S) enrichment sources before they can become durable or suppress a valid product.
- Preserve adapter failure metadata, but treat adapter failures as terminal for the current report so a task crash cannot repeat paid matcher/API work. A user may explicitly start a fresh report.
- Treat permanent adapter limitations (robots denial, 4xx/non-JSON output, unsupported or missing currency evidence) as terminal gaps so they cannot multiply paid matching or action-planning calls.
- Validate every durable gap's role, reason, code, failure kind, and HTTP status before it can influence retry classification.
- Persist exact matcher metadata, judged evidence, and the enrichment plan before enrichment starts, so a task replay after any process crash cannot repeat the paid matcher call.
- Add regression coverage for the mutually exclusive product/gap contract, invalid source schemes, and adapter recovery.

## Validation

- Run focused storefront-enrichment and orchestration tests.
- Run the full typecheck, build, and test suite.
- A fresh real public-domain report requires explicit approval because the owner paused paid API-key usage; deployment validation must not launch one implicitly.

## Review

Two independent fallback reviewers found blockers on earlier heads: invalid URL schemes could suppress valid products; cross-task adapter recovery could repeat paid calls across crash windows; and durable gap metadata was not fully validated. The implementation now preserves valid independent products, treats adapter failures as terminal for the current report, and validates all retry-relevant gap metadata. Fresh exact-head reviews are required before merge.

The cost-bound regression proves that a task replay after a terminal adapter gap performs one matcher request and one enrichment request in total, with no action-planning request for an unpublished pair.

## Data boundary

The change does not invent prices or promote incomplete evidence. A target that still lacks attributable price evidence remains an explicit gap; independently successful targets remain eligible for durable persistence.
