# Task 004 — Real public-domain source profile

## Goal

Replace the fixture-only submission path with a verified live scan of the submitted public domain.

## Scope

- Fetch the submitted public HTTP(S) domain with a bounded timeout and document-size limit.
- Extract public title, description, language, inferred region, headings, pricing patterns, social links, internal links, word count, source URL, and observed timestamp.
- Return normalized evidence and clear errors for non-HTML pages, HTTP failures, private addresses, and timeouts.
- Connect the report UI to the live response while keeping competitor and ad fixtures visibly labeled until their adapters exist.

## Acceptance criteria

- Submitting a real public domain calls `/api/analyze` and renders live source facts.
- The report links to the observed source URL and shows an observed-data label.
- Missing or blocked public pages produce a readable error state rather than silent fixture fallback.
- No API key or private credential is required.
- `npx vinext build` and `npm run lint` pass.
- The exact validated source is reviewed, pushed, and deployed privately on Sites.
