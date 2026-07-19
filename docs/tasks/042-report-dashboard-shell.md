# Task 042 — Report dashboard shell

## Outcome

Turn the saved intelligence report into a focused dashboard with persistent left navigation on desktop and a compact, scrollable section switcher on smaller screens.

## User problem

The existing oversized hero and six-column tab strip make the result feel like a long editorial report. The user wants a normal dashboard where the report sections are always easy to find and the selected intelligence view owns the main canvas.

## Acceptance criteria

- Replace the saved-report hero and floating horizontal desktop tabs with a two-column application shell.
- Show brand, report domain, status, observed date, and Overview, Competitors, Products, Ads, Evidence, and Methodology navigation in the desktop sidebar.
- Keep `?view=` URLs, browser history, hard-refresh restoration, and cross-view anchors working.
- Use vertical tab semantics and ArrowUp/ArrowDown navigation on desktop; use horizontal semantics and direction-aware navigation on the compact tab strip.
- Show truthful counts for Competitors, Products, and Evidence. Do not represent the absence of an ad-library result as zero ad activity.
- Keep a compact sticky header with current section, report freshness, language control, and New report action.
- Preserve every existing panel, truth label, coverage state, source link, and Price Position result.
- Mirror the rail and logical borders in Arabic without duplicating layout code.
- At 320px, expose all sections through one horizontally scrollable row with at least 44px targets and no page overflow.
- Do not change the landing page, report loading route, database, crawl, matching, or ad behavior.

## Review record

Claude Fable 5 (`claude-fable-5`) selected the two-column dashboard shell. It rejected merely shrinking the horizontal tabs and rejected a long scrollspy document because both preserve the wrong report mental model. Its binding requirements are reflected above.

Its first strict implementation review found one moderate acceptance gap: mobile hid both the sidebar identity and the header freshness. The compact mobile header now retains the observed date while hiding only the redundant status pill. The reviewer also identified two unrelated worktree files; they remain user-owned, untouched, and excluded from this task.
