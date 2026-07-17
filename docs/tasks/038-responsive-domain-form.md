# Task 038 — Responsive domain-entry form

## Problem

The landing-page domain input and submit button can exceed the available hero-column width in the narrow desktop range. The input flex item retains its intrinsic width while the button retains a fixed minimum width, clipping the call to action and creating horizontal overflow. The dark input is also rendered inside a white wrapper left over from the previous light theme.

## Outcome

- Allow the input wrapper and every form flex container to shrink within the viewport.
- Stack the domain input and full-width submit button at 900px and below, where the two-column form is no longer readable.
- Stack the hero into one column in the same range so its content and preview remain within the page width.
- Apply the dark field surface to the whole input wrapper instead of leaving a white frame.
- Preserve the wide-desktop inline form, Arabic direction, keyboard submission, and existing loading behavior.

## Acceptance criteria

1. The page has no horizontal overflow at 390px, 700px, 768px, 900px, or wide desktop widths.
2. The entire submit button and its label remain visible at every tested width.
3. At 900px and below, the input and button form a single-column stack and the button fills the form width.
4. Above 900px, the input and button remain inline.
5. The input wrapper uses the dark theme consistently without a white outer frame.
6. English and Arabic landing pages remain usable.
7. Build, tests, lint, Go tests, strict Fable 5 review, exact Sites deployment, production browser QA, and Fable merge pass.

## Data boundaries

This is a presentation-only fix. It does not alter crawling, competitor discovery, product matching, report persistence, or evidence handling.
