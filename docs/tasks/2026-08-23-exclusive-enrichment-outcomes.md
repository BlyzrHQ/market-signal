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
- Persist and validate the exact final action-plan outcome before relational fact persistence in a bounded task-attempt namespace (`3910` through `3919`), so a persistence-tail replay adopts a matching saved plan while a later attempt with legitimately evolved evidence can use its own slot.
- Send the paid action-planning HTTP request at most once per orchestration invocation. An ambiguous transport failure adopts and checkpoints deterministic recommendations instead of blindly repeating the POST.
- Mark a transient enrichment gap `retryExhausted` after the one bounded cross-task retry is consumed, including when that retry returns another gap or loses its response. Later task attempts treat the saved gap as terminal.
- Add regression coverage for the mutually exclusive product/gap contract, invalid source schemes, and adapter recovery.

## Validation

- Run focused storefront-enrichment and orchestration tests.
- Run the full typecheck, build, and test suite.
- A fresh real public-domain report requires explicit approval because the owner paused paid API-key usage; deployment validation must not launch one implicitly.

## Review

Two independent fallback reviewers found blockers on earlier heads: invalid URL schemes could suppress valid products; cross-task adapter recovery could repeat paid calls across crash windows; and durable gap metadata was not fully validated. The implementation now preserves valid independent products, treats adapter failures as terminal for the current report, and validates all retry-relevant gap metadata.

A verified interactive Fable 5 session reviewed pushed head `0b1bf24dd33ddb5b091dcc4de1383a62b84299be` read-only. It identified three remaining practical blockers: action planning lacked a durable outcome checkpoint, the HTTP adapter retried an ambiguous paid action POST, and transient enrichment gaps could remain retryable after their one retry was consumed. Those findings directly produced the additional action checkpoint, single-attempt action transport, and `retryExhausted` state in this change. A fresh strict Fable 5 review of the exact final head remains required before merge.

Fable 5 then strictly reviewed pushed head `471d9d3b3671bf2d28ae3cae2aff70b771f4448f` and blocked it because one shared action slot would reject legitimate evidence evolution during recovery. The follow-up namespaces action outcomes per task attempt, adopts any prior slot only when its input hash matches, skips stale prior slots, and reserves fail-closed conflict handling for the current task slot. Regression coverage now exercises both byte-identical adoption and changed-evidence progress.

The guarantee is deliberately precise: the system provides at-most-once adoption of a saved action outcome and bounded action dispatch. It does not claim strict provider-level at-most-once execution across the unavoidable crash window between a remote provider accepting a request and the local durable checkpoint committing.

The cost-bound regression proves that a task replay after a terminal adapter gap performs one matcher request and one enrichment request in total, with no action-planning request for an unpublished pair.

The final local validation completed without live reports or paid evaluations: typecheck, node typecheck, production build, and 1,078 tests passed. Focused regression coverage proves that a persistence-tail replay makes one action-planner call in total, a stale prior action slot does not block evolved evidence, an ambiguous paid action request makes one HTTP POST, a corrupt current-slot checkpoint fails closed, and a transient enrichment target is dispatched at most twice across task attempts.

## Data boundary

The change does not invent prices or promote incomplete evidence. A target that still lacks attributable price evidence remains an explicit gap; independently successful targets remain eligible for durable persistence.
