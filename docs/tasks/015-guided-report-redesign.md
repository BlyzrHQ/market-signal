# Task 015 — Guided rival-dossier report

## Problem

The report presents accurate information as a flat stack of similarly weighted cards. Users must reconstruct each competitor story across separate competitor, product, advertising, and evidence sections.

## Decision

Make the rival—not the data type—the unit of the report. Present one guided sequence:

1. Executive verdict and real outcome counts.
2. Ranked threat map with a shared verification-score axis and ad-status pulse.
3. Expandable rival dossiers joining proof, product battles, prices, ads, sources, and the first recommended move.
4. Collapsed evidence and coverage appendix.

## Truth boundaries

- A score bar visualizes the existing verification score only.
- A price graphic appears only when both public prices contain one parseable amount in the same currency.
- Ad status remains unverified unless a direct official-library record passed the existing evidence gate.
- Every decision remains linked to the underlying public product or discovery source.

## Acceptance

- The eye has one obvious start and numbered path through the report.
- Rival ranking and dossier order are identical.
- Product, price, ad, and recommended-action evidence is grouped by rival domain.
- Ambiguous prices fall back to text and never produce a chart.
- Arabic/RTL and narrow screens preserve the narrative without horizontal scrolling.
- Build, lint, automated tests, real MyJam validation, strict Fable review, deployment, and Fable merge all pass.
