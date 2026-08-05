# Task 106 — Harden saved-report JSON polling

## Customer problem

A live `myjam.co.uk` run exposed the browser-native error `Unexpected end of JSON input` when the loading screen received an empty or truncated API response. The API normally returns valid JSON and a real control run was accepted, but the loading and saved-report routes bypassed the shared safe JSON response boundary.

## Scope

- Route loading-screen and saved-report reads through `readJsonResponse`.
- Never expose native JSON parser messages to a customer.
- Keep polling after a transient malformed, empty, HTML, or interrupted response so a live run can recover without a refresh.
- Preserve terminal report handling and durable report redirects.

## Acceptance

- Both customer report routes contain no direct `response.json()` call.
- A transient polling error is translated into useful guidance and retried.
- Existing report-route and JSON-response tests pass.
- A real `myjam.co.uk` report can be created and its saved status endpoint returns complete JSON.

## Data boundary

This changes transport resilience only. It does not invent crawl results, modify stored evidence, or reinterpret report content.
