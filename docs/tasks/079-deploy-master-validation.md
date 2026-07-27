# Task 079 — Credential-free master revision validation

## Goal

Allow the manually dispatched VPS deployment workflow to validate and build an
exact first-parent `master` revision after checkout credentials are removed.

## Failure observed

GitHub Actions run `30273270288` failed before build or SSH because the
validation step ran `git fetch origin master` after
`persist-credentials: false`. Production was not touched.

## Change

- Check out full `master` history once through the pinned checkout action.
- Keep checkout credentials disabled.
- Validate the requested full SHA locally against `origin/master`.
- Require the SHA to be on the first-parent history.
- Detach to the exact validated SHA before building.

## Acceptance

- Workflow and shell validation pass.
- Focused VPS tests pass.
- No post-checkout network fetch or persisted GitHub credential exists.
- The exact approved revision is built and emitted for deployment.
- Independent review passes before merge.
