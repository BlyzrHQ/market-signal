# Homepage My Reports navigation

## Problem

The public landing-page header always links to `/account` with the label `Account`. A signed-in paid user can therefore see that an account exists but has no clear route from the homepage back to the private reports dashboard. The owned-report workspace already lists recent reports in its sidebar, so creating a second dashboard would duplicate the existing navigation model.

## Scope

- Resolve the landing-page account link from the private `/api/account/reports` endpoint after hydration.
- Show `My reports` for an authenticated user and link to the newest valid owned report's product view.
- Fall back to `/account` for anonymous users and authenticated users without a saved report.
- Keep the workspace link visible in the compact landing-page header.

## Acceptance

- Anonymous visitors see `Account` linking to `/account`.
- Authenticated users with saved reports see `My reports` linking to the newest valid `/reports/{publicId}?view=products` route.
- Authenticated users without a saved report see `My reports` linking to `/account`.
- The link remains visible at desktop, tablet, and phone widths in English and Arabic.
- Failed or malformed private-history responses fail closed to the account route.
- Typecheck, build, focused tests, full tests, lint, and an authenticated browser check pass.

## Data boundaries

The homepage does not receive private report history during public rendering. It performs a same-origin, no-store request after hydration and reuses the existing workspace-scoped endpoint. This task does not change authentication, authorization, report ownership, sharing, billing, report facts, or API response shapes.
