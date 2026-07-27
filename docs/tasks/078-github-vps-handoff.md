# Task 078 — GitHub-to-VPS production handoff

## Goal

Allow an operator on another laptop to add a fresh OpenAI project key without
putting it in chat or Git, then deploy an exact Fable-approved `master` commit
to the Market Signal VPS through a protected, manually dispatched GitHub
Actions workflow.

## Decision

Fable 5 recommended a two-stage workflow:

1. validate and build an exact 40-character commit from `master`, then publish
   the image to private GHCR by immutable digest;
2. enter the protected `production` environment, pin the VPS SSH host key,
   update only `OPENAI_API_KEY` through standard input, preserve the existing
   Trigger credentials and SQLite volumes, take a verified online backup, and
   deploy with `docker compose --no-build`.

Push-triggered deployment, a self-hosted runner, rebuilding on the VPS,
storing the full runtime environment in GitHub, and long-lived registry
credentials on the VPS were rejected.

## Scope

- Add a `workflow_dispatch`-only production workflow.
- Add a root-owned helper that atomically updates only the OpenAI key.
- Add a one-time installer for a dedicated GitHub Actions deploy account.
- Add a remote release script with strict revision, digest, backup, health,
  and data-preservation checks.
- Permit the expected Caddy listeners in repeatable VPS preflight checks.
- Add an operator handoff guide and static regression tests.

## Security boundaries

- A credential pasted into chat remains ineligible.
- GitHub stores only the fresh OpenAI key and the dedicated SSH private key.
- Trigger credentials remain only in `/etc/market-signal/market-signal.env`.
- The VPS host key is pinned from the already trusted provisioning session;
  the workflow never runs `ssh-keyscan`.
- Secrets travel through standard input and never command-line arguments.
- The workflow contains no database deletion, volume deletion, image pruning,
  release deletion, DNS mutation, or Sites retirement.
- The manually dispatched workflow is stored at
  `.github/workflows/deploy-vps.yml` and remains subject to Actions validation
  plus the strict Fable merge gate.
- The deploy account is in the Docker group and is therefore effectively
  root-equivalent. Its key is dedicated, environment-scoped, and must be
  rotated after any suspected runner or repository compromise.

## Acceptance criteria

1. Only `workflow_dispatch` can start the workflow.
2. A short SHA, a commit outside `origin/master`, or an interior feature-branch
   commit that was never a first-parent `master` state fails before build or
   SSH.
3. The GHCR digest and OCI revision label are carried into deployment and
   verified against the running container.
4. A wrong SSH host key fails closed; no trust-on-first-use fallback exists.
5. A missing runtime env file fails before deployment.
6. Updating OpenAI configuration preserves every other env line and mode.
7. Existing SQLite data receives an online backup and integrity verification
   before a release switch.
8. The app must become healthy and public HTTPS must return successfully with
   at least 14 days remaining on the certificate.
9. Old image tags and release directories remain available for explicit
   rollback.
10. Tests, builds, lint, strict Fable review, merge, and first deployment are
    recorded before this task is complete.
