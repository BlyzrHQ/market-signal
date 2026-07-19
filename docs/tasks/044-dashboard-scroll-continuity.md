# Task 044 — Dashboard scroll continuity

## Outcome

Make the report dashboard use one predictable page scroll instead of giving the desktop sidebar an independent full-height scrolling surface.

## User problem

The left report section appears frozen while the report content moves. A fixed `100vh` sidebar with its own overflow also makes wheel and trackpad behavior depend on where the pointer is placed.

## Acceptance criteria

- Desktop report pages use the document as the only vertical scrolling surface.
- The left navigation and its dark background participate in the full report layout rather than forming an independent `100vh` viewport.
- The mobile/tablet horizontal tab bar remains sticky below the report header.
- Tab clicks and route query parameters continue to switch report sections.
- No horizontal overflow is introduced at desktop or 320px mobile widths.
- Validate against a real saved Babanuj report.

## Implementation

- Remove sticky positioning, fixed viewport height, and internal vertical overflow from the desktop sidebar.
- Stretch the sidebar through the report grid with a minimum viewport height so short reports still fill the screen.
- Preserve the existing responsive sticky tab bar below 1024px.

## Validation record

- `npm test`: typecheck, vinext build, and 210/210 Node tests pass.
- `npm run lint`: zero errors; two existing remote-image optimization warnings remain.
- `go test ./cli/... ./contracts/...`: passes.
- `git diff --check`: passes apart from the repository's existing line-ending notices.
- Fable 5 pre-PR review approved the change with no blockers after checking grid sizing, long-report behavior, responsive rules, overflow, and regression-test discrimination. Its regex-scoping nit was applied.
- Pull request merge, deployment, and live Babanuj verification remain pending.
