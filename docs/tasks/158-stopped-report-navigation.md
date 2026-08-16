# Task 158 — stopped report navigation

## Problem

Paid users can open failed or interrupted runs from the new sidebar history, but
those runs still render the legacy full-screen error state. The sidebar then
disappears and the user cannot switch back to another saved report.

The production example is `asalbarri.sa`: the run truthfully stopped because
its public homepage returned HTTP 403. The failure is real; the dead-end
presentation is the defect.

## Change

- Keep stopped runs in history so account activity remains truthful.
- Render failed/interrupted runs inside a dedicated dashboard shell with the
  private, client-fetched paid report history.
- Show no report tabs, counts, or zero-result claims when no document exists.
- Explain recognized HTTP 403 failures in plain language while preserving the
  exact stored error in a technical disclosure.
- Provide visible New report and website actions on desktop and mobile.
- Normalize irrelevant `view`, `layout`, and fragment state on stopped pages.

## Boundaries

- No fields are added to the public report API.
- Private history remains gated by `/api/account/reports` and is never embedded
  into the public report payload.
- Retry is navigation to the existing creation flow, not an automatic paid run.
- Unknown failure messages remain visible exactly as stored.

## Review

Verified Claude Fable 5 endorsed a dedicated stopped-report shell and required
that it avoid empty result tabs, retain the verbatim error, avoid auto-retry,
and keep a mobile recovery action visible.

## Validation

- Focused stopped-report and report-route tests.
- Full test, build, and lint gates.
- Strict exact-head Fable 5 review.
- Live verification against the saved failed `asalbarri.sa` report.
