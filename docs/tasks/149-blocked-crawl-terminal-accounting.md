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
  release it for `failed` or `interrupted` terminal states;
- create deterministic, zero-AI-cost `run_failure` evaluations for failed and
  interrupted reports so every terminal run enters the feedback loop.

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
edge result's bounded candidate evidence. Product, company, and price source
URLs remain constrained to observed result domains or the existing trusted
evidence hosts. Failure evaluations contain terminal run/event metadata only
and make no model call.
