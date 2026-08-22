# Exclusive product-enrichment outcomes

## Problem

Production report `4d5bce140f124478b951ed1846ef2edf` found valid judged product pairs, but both enrichment batches were discarded. The enrichment endpoint could return one target as both a product and an unresolved adapter gap, while the durable checkpoint contract correctly requires exactly one outcome per target.

## Change

- Treat a product with an unresolved adapter price gap as a gap-only outcome so it can be retried safely.
- Preserve successful products from other targets in the same batch.
- Reject non-HTTP(S) enrichment sources before they can become durable or suppress a valid product.
- Preserve adapter failure metadata and re-fetch only transient network, throttling, timeout, and 5xx targets on a later bounded task attempt.
- Treat permanent adapter limitations (robots denial, 4xx/non-JSON output, unsupported or missing currency evidence) as terminal gaps so they cannot multiply paid matching or action-planning calls.
- Permit at most one retry for a transient adapter failure and defer action planning while enrichment remains retryable.
- Persist the exact matcher metadata, judged evidence reference, and enrichment plan only when a transient enrichment retry is required. The next task reuses that durable state instead of calling the paid matcher again.
- Treat a transport failure during that single retry as consumed, terminalize it durably, and prevent a third task from repeating the request.
- Add regression coverage for the mutually exclusive product/gap contract, invalid source schemes, and adapter recovery.

## Validation

- Run focused storefront-enrichment and orchestration tests.
- Run the full typecheck, build, and test suite.
- A fresh real public-domain report requires explicit approval because the owner paused paid API-key usage; deployment validation must not launch one implicitly.

## Review

Two independent fallback reviewers found blockers on the first head: invalid URL schemes could suppress valid products, and adapter-limited gaps were not retryable. Later exact-head reviews found that broad or repeated adapter retries could multiply paid API calls. The implementation now preserves transient metadata, terminalizes permanent adapter limitations, caps transient adapter recovery at one retry, and defers action planning until processing is no longer retryable. Fresh exact-head reviews are required before merge.

The cost-bound regression proves that two task attempts perform one matcher request, at most two enrichment requests (the original plus one retry), and no action-planning request while enrichment is incomplete. A failed retry transport is also saved as exhausted before a third task replay.

## Data boundary

The change does not invent prices or promote incomplete evidence. A target that still lacks attributable price evidence remains an explicit gap; independently successful targets remain eligible for durable persistence.
