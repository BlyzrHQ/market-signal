# Task 019 — Recover from non-JSON API responses

## Problem

The report client parsed every `/api/crawl` and `/api/report` response with `response.json()`. If the hosting or authentication layer returned an HTML timeout, gateway, or sign-in page, the user saw the browser's raw `Unexpected token '<'` parser error instead of a useful product message.

## Goal

Never expose an HTML response as a JSON parser failure. Preserve the real crawl, explicitly request same-origin JSON, and give the user accurate recovery guidance when the surrounding service interrupts a report.

## Method

1. Read the response body once and verify its content type before parsing.
2. Distinguish session failures, temporary service failures, and malformed JSON without exposing response HTML.
3. Send explicit JSON accept, no-cache, and same-origin session options on report requests.
4. Use the same response boundary for the crawl and the AI market brief.
5. Replace upstream discovery parser failures with a fixed product message before they can enter the JSON-rendered report.

## Acceptance

- Valid JSON responses continue to render normally.
- HTML gateway or timeout responses produce a concise retry message.
- HTML authentication responses instruct the user to refresh the session.
- Malformed JSON never exposes the browser's native parser error.
- A real production MyJam run still returns a live JSON report with verified competitors.
- Tests, lint, build, strict Fable 5 review, PR, deployment, and live verification pass.
