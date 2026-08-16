# Blocked crawl recovery and terminal accounting

## Problem

The live `asalbarri.sa` report failed even though the Sites egress could crawl
the storefront. The VPS rejected one independently sourced discovery URL in the
otherwise valid edge payload, hid that reason behind HTTP 400, committed the
monthly report reservation before the report completed, and produced no
terminal evaluation.

## Scope

- keep the VPS as the product host and use the configured Sites endpoint only
  as bounded crawl egress for dual-host HTTP 403 storefronts;
- validate declared third-party discovery evidence without allowing unrelated
  off-domain product or company facts;
- return bounded, typed edge-recovery diagnostics to the Trigger worker;
- reserve a report at dispatch, commit it only for `complete` or `limited`, and
  release it only for an irreversible `failed` state while an `interrupted`
  run keeps its reservation for explicit recovery;
- create deterministic, zero-AI-cost `run_failure` evaluations only for failed
  reports; interrupted reports remain recoverable and are not permanently graded.

The reservation lease is four hours, safely beyond the bounded two-attempt
worker window. Reservation state is monotonic: committed usage can never be
released by a stale callback. The historically miscommitted Asalbarri test row
will be corrected once with an explicit audited database operation after the
runtime fix is deployed; that backward transition is deliberately unavailable
through application code.

## Validation

- focused edge recovery, orchestration HTTP, billing, report-store, and internal
  callback tests;
- full test, lint, and production build;
- strict Fable 5 review of the exact PR head;
- Trigger deployment before the exact approved VPS commit;
- a fresh live `asalbarri.sa` report proving a recovered catalog, terminal
  quota settlement, and a persisted evaluation.

## Data boundaries

Third-party discovery pages are accepted only when explicitly declared in the
edge result's bounded candidate evidence fields. The allowance is path-scoped,
not domain-scoped, so repeating that URL in product, company, or price source
data is rejected. Product, company, and price source
URLs remain constrained to observed result domains or the existing trusted
evidence hosts. Failure evaluations contain terminal run/event metadata only
and make no model call.

## Review record

Verified Fable 5 reviewed commit `324bcd675458705d2324198709c3233089bf5987`
and blocked it on reservation lifetime, interrupted-state handling, billing
state regression, public internal identifiers, over-broad discovery evidence,
and lost typed crawl diagnostics. The follow-up implementation addresses all
six findings and must receive a fresh strict review on its exact commit before
merge.
