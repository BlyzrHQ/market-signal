# Task 082 — Decision-oriented benchmark scorecard

## Outcome

Replace the repeated three-bar benchmark chart with a compact scorecard that
shows the user's position, the market median, the observed leader, and the
evidence-backed action implied by each gap.

## User problem

The current graph asks the user to visually compare 18 separate progress bars.
It uses substantial vertical space but does not make the largest weakness,
strongest advantage, or next action obvious.

## Product rules

- Preserve the existing evidence and scoring model; this task changes
  presentation, not measurement.
- Keep the user, market median, and observed leader visible on one shared
  0–100 scale per metric.
- Sort known metrics by decision priority: below-market gaps first, then
  market-level results, then strengths.
- State the user's delta from the median in text so meaning never depends on
  color or marker position.
- Keep unknown scores visibly unknown and exclude them from gap claims.
- Use measured language: these are public-crawl readiness signals, not
  subjective design quality or real-user performance.
- Support English, Arabic, keyboard/screen-reader interpretation, narrow
  screens, and no horizontal page overflow.

## Proposed interaction

- A concise summary names the largest proven gap and strongest proven
  advantage.
- Each metric uses one comparison track with labeled markers for the user,
  market median, and observed leader.
- A status label states whether the user is behind, at, or ahead of the median
  and by how many points.
- A short action cue explains what evidence to improve without inventing a
  business outcome.

## Acceptance criteria

1. The old three-progress-bar groups are removed.
2. Every known metric renders one shared comparison track and exact values.
3. The largest below-median gap appears first.
4. Unknown values render as unknown and never as zero or a loss.
5. The view remains understandable without color and at mobile widths.
6. Existing report evidence and formulas are unchanged.
7. Automated presentation tests cover ordering, truth boundaries, labels, and
   responsive CSS.
8. A real persisted MyJam report is visually checked after deployment.

## Review

Fable 5 with high effort completed the read-only product-decision review and
returned `PASS`. It approved the single-track scorecard and rejected keeping
the repeated bars, a second heatmap, a radar chart, and an all-competitor
dumbbell plot. Its material requirements are implemented:

- deterministic priority ordering with unknowns last;
- text as the source of truth and markers as illustration;
- distinct marker shapes rather than color-only meaning;
- evidence-derived actions only for proven below-median gaps;
- logical marker positioning for Arabic; and
- explicit mobile stacking.

The first strict code review returned `FAIL` with two major blockers:

1. LTR and RTL marker-centering transforms were reversed.
2. The three-column row could clip the decision text between 701px and 764px.

Both blockers were fixed. The same pass also added a specific observed
product-path action, mirrored RTL row tinting, retained all-market-unknown
metrics as unknown rows, and added direct action-branch tests. The verified
Fable 5 high-effort strict re-review returned `PASS` with no blocker or major
finding. It marked the change safe to merge after post-deployment visual
validation against a real persisted MyJam report.

## Validation

- Focused benchmark tests after review fixes: 8/8 passed.
- TypeScript check: passed.
- Production Sites build: passed.
- Final full automated suite: 374/374 passed.
- ESLint: passed with zero errors and two pre-existing `no-img-element`
  warnings outside this task.
- VPS production build assertion: passed.
- Post-deployment real MyJam visual validation is pending.
