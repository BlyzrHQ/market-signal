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
  - `VPS_HOST=127.0.0.1`
  - `VPS_USER=market-deploy`
  - `MARKET_SIGNAL_DOMAIN=signal.blyzr.com`
  - `VPS_HOST_KEY=127.0.0.1 ssh-ed25519 <trusted host key>`
- environment secret:
  - `VPS_SSH_PRIVATE_KEY=<dedicated deploy private key>`

The matching public key is installed by running the reviewed
`deploy/vps/install-github-deploy-user.sh` once through the existing trusted
root session. The VPS host key must be read from that trusted session or the
provider console. Never generate it with `ssh-keyscan` inside Actions.

The deploy job runs on a one-job repository JIT runner launched on the VPS.
The image build remains on GitHub-hosted infrastructure. The GitHub operator
needs repository administration plus organization runner-group access and
must use an authenticated `gh` session without printing its token.

## What the operator does on another laptop

1. Revoke any key that was pasted into chat.
2. Create a fresh OpenAI project key.
3. Open the private `BlyzrHQ/market-signal` repository.
4. Go to **Settings → Environments → production → Environment secrets**.
5. Create or replace `OPENAI_API_KEY` with the fresh key.
6. Open **Actions → Deploy approved Market Signal revision → Run workflow**.
7. Enter the full 40-character SHA of the independently approved commit on
   `master`.
8. Wait for the `build` job to pass. The `deploy` job will remain queued until
   the one-job runner below connects.
9. If the repository plan has an environment reviewer rule, approve the
   `production` environment when prompted or ask an eligible reviewer.
10. From an authenticated operator shell, discover the approved runner group,
    request one repository JIT configuration, and pipe it directly to the
    reviewed launcher on the VPS:

    ```bash
    RUNNER_GROUP_ID="$(
      gh api orgs/BlyzrHQ/actions/runner-groups \
        --jq '.runner_groups[] | select(.name == "Default") | .id'
    )"
    test -n "${RUNNER_GROUP_ID}"
    JIT_CONFIG="$(
      gh api --method POST \
        repos/BlyzrHQ/market-signal/actions/runners/generate-jitconfig \
        -f "name=market-signal-production-$(date +%s)" \
        -F "runner_group_id=${RUNNER_GROUP_ID}" \
        -f "work_folder=_work" \
        -f "labels[]=self-hosted" \
        -f "labels[]=linux" \
        -f "labels[]=x64" \
        -f "labels[]=market-signal-production" \
        --jq '.encoded_jit_config'
    )"
    test -n "${JIT_CONFIG}"
    printf '%s\n' "${JIT_CONFIG}" |
      ssh root@191.218.162.18 \
        /usr/local/sbin/run-market-signal-ephemeral-runner
    unset JIT_CONFIG
    ```

    Install `/usr/local/sbin/run-market-signal-ephemeral-runner` from the exact
    reviewed `deploy/vps/run-ephemeral-github-runner.sh` commit before this
    step. Do not launch the runner before the build passes: its 80-minute
    lifetime includes queue wait and deploy execution.
11. Wait for backup, deploy, TLS, health, digest, and revision checks to pass.
12. Confirm the runner account, unit, work directory, runtime HOME, and cleanup
    helper have been removed. After a hard reboot during a job, run the
    root-owned cleanup helper before relaunching if those fail-closed guards
    remain.
13. Run a real report at `https://signal.blyzr.com` and confirm competitor and
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

The repository JIT configuration is delivered to the launcher through standard
input and stored under root-only `/run` state. GitHub's runner process receives
that single-use value through its documented `--jitconfig` command argument,
which is briefly visible to local host process inspection and `systemctl
status`. The VPS is treated as a single-tenant trusted host, application
containers use separate PID namespaces, and the credential is consumed by one
registration before root-owned cleanup removes the runner state.
