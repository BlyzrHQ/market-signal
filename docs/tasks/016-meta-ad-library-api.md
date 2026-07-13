# Task 016 — Meta Ad Library API

## Goal

Query Meta's Ads Archive server-side for each verified competitor and replace vague Meta search status with API-backed active-ad evidence when the connected Meta app is authorized.

## Truth boundaries

- Keep the access token only in a secret server environment variable.
- Send the token in the Authorization header, never in URLs, logs, evidence links, or browser payloads.
- Count only records returned by Meta. Mark capped or paginated counts as lower bounds.
- A zero-result query is not proof of zero global advertising.
- An authorization failure is an `access-limited` state with Meta's stable error code, not an empty result.
- Exact spend for ordinary commercial ads remains unavailable and must not be inferred.

## Acceptance

- Authorized responses produce direct `facebook.com/ads/library/?id=...` evidence links.
- Error `10 / 2332002` produces a clear application-authorization message.
- API success, empty results, rejected permissions, and token leakage are covered by tests.
- Existing Google and TikTok evidence behavior remains unchanged.
- Build, lint, test, strict Fable 5 review, PR, Sites deployment, and a real Meta endpoint validation are complete before merge.

## Current external state

The supplied token is valid for the connected Meta account, but Meta currently rejects Ads Archive access with OAuth error `10`, subcode `2332002`. The implementation must be ready for authorization without claiming that API data is available before Meta grants it.
