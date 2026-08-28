# Fix product price-watch activation

## Problem

Owned report rows displayed a switch before the authoritative saved match page had loaded. During that window the compact presentation rows carried display-only keys such as `0-0`, so the switch was rendered disabled and clicking it sent no request. The visual control also depended on a hidden checkbox plus label forwarding, which made the activation affordance unnecessarily fragile.

Production evidence for the owned `babanuj.com` report showed 16 price-eligible matches with 64-character persisted match IDs, an active Solo subscription, 5,000 monitoring credits, and no watcher activation request when the inert switch was clicked. Billing and stored match eligibility were therefore not the blocker.

## Change

- Show item-level watch controls only after authoritative saved match facts are ready.
- Use a real button with `role="switch"` and `aria-checked` instead of a pointer-disabled hidden checkbox.
- Keep the current daily/hourly cadence selector and existing server-owned activation checks.
- Show a clear saving state while a watcher mutation is in flight.

## Truth and cost boundaries

- The UI can activate only an owned, persisted, price-eligible report match.
- The server remains authoritative for subscription, credit, URL, currency, and price validation.
- No crawler, search, matching, evaluation, or paid AI work is part of this fix.
- A live activation test consumes exactly one monitoring credit for the baseline check and must be explicitly authorized before it is performed.

## Validation

- Focused route and rendering tests: 35/35 passed.
- Typecheck passed.
- Lint passed with the repository's pre-existing `no-img-element` warning only.
- VPS build and runtime assertions passed.
- Full suite: 1,203/1,203 tests passed.
- Strict Fable 5 review of the exact PR head.
- Live verification against the owned `babanuj.com` report after deployment.
