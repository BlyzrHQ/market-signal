# Task 098 — Edge recovery secret hygiene

## Problem

The deployed Sites runtime receives the edge marker and redacted Authorization header but returns HTTP 401 even after the callback credential is rotated and synchronized. This keeps Trigger-backed reports from recovering storefronts that deny the VPS, and it unnecessarily sends the credential that protects the VPS internal API to a public crawl endpoint.

## Decision

- Keep the exact hardcoded Sites origin/path, distinct-origin check, one-attempt budget, manual redirect policy, response bounds, validation, and provenance from Task 097.
- Send the edge request as a normal public crawl request. Do not transmit the callback credential or recursion marker.
- Require the explicit VPS Compose identity `MARKET_SIGNAL_DEPLOY_TARGET=node` before any edge egress. Sites does not use the VPS Compose manifest, so it cannot recurse even if the edge URL is accidentally configured there.
- Retain the valid local callback credential as a second VPS-side enablement gate, but never serialize it into the outbound request.
- Keep inbound marked-request authentication unchanged and fail closed.
- Remove the callback secret from Sites after deployment and rotate the VPS credential because the previous implementation transmitted it off-box.

## Acceptance

- Tests prove the outbound request contains neither Authorization nor marker and never contains the local credential.
- Missing/non-node deployment identity and missing/short local credentials produce zero edge fetches.
- Existing exact-origin, dual-403-only, inbound-auth, validation, bounds, and provenance tests remain green.
- Full test, typecheck, production build, VPS build, and lint gates pass.
- A fresh Trigger-backed Babanuj report progresses beyond crawl and records edge-recovery provenance.

## Follow-up boundary

Product image and price extraction quality remains a separate task measured on the fresh persisted report. This task restores the safe report transport path without changing extraction heuristics.
