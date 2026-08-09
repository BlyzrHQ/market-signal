# Task 127: Refine header branding

## Outcome

Make the Market Signal header feel like a finished product: remove the Beta
badge from the wordmark, replace the generic bar icon with a distinctive signal
graph mark, and turn the language control into a clear two-state switch.

## Scope

- Replace the three-bar logo in the landing header and shared footer.
- Keep the mark code-native and crisp at every density.
- Remove the Beta badge from the header wordmark.
- Redesign the English/Arabic switch with visible current-state styling.
- Preserve keyboard focus, accessible labels, RTL behavior, and mobile fit.
- Leave the trusted-row line before `STARTUPS` unchanged for now, as requested.

## Acceptance criteria

1. No Beta badge appears inside the landing-page logo.
2. Header and footer use one shared brand-mark component.
3. The language switch clearly indicates whether English or Arabic is active.
4. The control remains operable by keyboard and has a descriptive accessible label.
5. Typecheck, build, lint, and focused source tests pass.
