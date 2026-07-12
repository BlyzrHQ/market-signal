# Task 008 — Accept full pasted URLs

## Goal

Let users paste a complete URL directly into the primary or comparison field.

## Changes

- Removed the fixed `https://` visual prefix.
- The field accepts `https://example.com/path`, `http://example.com`, or a bare
  domain such as `example.com`.
- The existing server normalizer remains responsible for protocol defaults,
  hostname extraction, path handling, and public-address validation.

## Acceptance criteria

- The form has no fixed protocol prefix.
- Full URLs and bare domains reach the same public-source scanner.
- Comparison inputs preserve complete pasted URLs too.
- Build, lint, rendered tests, and a real-domain check pass.

## Review record

Explicit Sonnet 5 review found no blockers. It confirmed the fixed protocol
prefix is gone, full URLs and bare domains both reach the existing safe
normalizer, and the live evidence flow is unchanged. A pre-existing behavior
remains: the scanner currently treats submitted URLs as public-domain inputs
and fetches the normalized homepage rather than preserving a pasted path.
