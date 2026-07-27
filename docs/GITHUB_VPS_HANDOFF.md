# GitHub VPS handoff

This handoff lets an operator use any laptop with GitHub access. A fresh OpenAI
key is entered directly into GitHub's protected `production` environment and
is never pasted into Codex, a PR, an issue, or a repository file.

## One-time repository setup

The manually dispatched workflow is stored at
`.github/workflows/deploy-vps.yml`. Do not merge changes to it until Actions
validation and the required independent release review pass.

The repository administrator creates the `production` environment with:

- deployment branches restricted to `master`;
- required reviewers with self-review disabled when the repository plan
  supports them;
- environment variables:
  - `VPS_HOST=191.218.162.18`
  - `VPS_USER=market-deploy`
  - `MARKET_SIGNAL_DOMAIN=signal.blyzr.com`
  - `VPS_HOST_KEY=<trusted known_hosts line>`
- environment secret:
  - `VPS_SSH_PRIVATE_KEY=<dedicated deploy private key>`

The matching public key is installed by running the reviewed
`deploy/vps/install-github-deploy-user.sh` once through the existing trusted
root session. The VPS host key must be read from that trusted session or the
provider console. Never generate it with `ssh-keyscan` inside Actions.

## What the operator does on another laptop

1. Revoke any key that was pasted into chat.
2. Create a fresh OpenAI project key.
3. Open the private `BlyzrHQ/market-signal` repository.
4. Go to **Settings → Environments → production → Environment secrets**.
5. Create or replace `OPENAI_API_KEY` with the fresh key.
6. Open **Actions → Deploy approved Market Signal revision → Run workflow**.
7. Enter the full 40-character SHA of the independently approved commit on
   `master`.
8. Approve the `production` environment when prompted, or ask an eligible
   reviewer to approve it.
9. Wait for build, backup, deploy, TLS, health, digest, and revision checks to
   pass.
10. Run a real report at `https://signal.blyzr.com` and confirm competitor and
    product-match results before retiring any rollback deployment.

If SQLite exists but the current app container is stopped, deployment fails
before changing the release. Restore the current app through the trusted VPS
session, verify the database and an online backup, then dispatch again. Do not
bypass the backup gate or overwrite the live database.

## Rollback

Post-switch startup and health failures automatically restore and verify the
previous release while preserving the SQLite volume and verified backup.
For an operator-requested rollback, dispatch the same workflow with the full
SHA of the previous approved `master` commit. Old release directories and
image tags are deliberately not deleted. Database restoration is separate
and is required only when a schema change is not backward compatible.

## Secret boundary

GitHub stores the fresh OpenAI key and dedicated SSH private key. Existing
Trigger credentials remain in `/etc/market-signal/market-signal.env` on the
VPS. The workflow updates exactly one line in that file through standard
input. It never reconstructs or prints the complete environment.
