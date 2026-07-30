# Task 080 — VPS-local deployment runner

## Goal

Run only the production deployment job on a one-job, labeled JIT runner on the
Market Signal VPS while retaining GitHub-hosted image builds.

## Failure observed

Runs `30274441470` and `30274206024` proved build, revision validation, secrets,
and SSH key parsing independently. The second run timed out connecting from a
GitHub-hosted runner to Hostinger port 22 before staging or production changes.
The VPS firewall and SSH daemon accept port 22 publicly, and the same dedicated
key passes preflight from the trusted operator machine.

## Change

- Keep the untrusted build and GHCR publication job on `ubuntu-24.04`.
- Route only the protected deploy job to an ephemeral runner carrying the
  `market-signal-production` label.
- Run the existing pinned SSH flow against loopback on the VPS.
- Supervise the runner with a root-owned systemd unit and remove its work,
  credentials, service unit, and account on every exit.
- Cap the complete runner lifetime at 80 minutes and terminate its entire
  control group on timeout.
- Keep runner HOME under `/run` so an SSH key cannot survive a hard reboot.
- Restrict the deploy SSH public key to loopback and disable forwarding/PTY.
- Keep the production environment, exact SHA/digest checks, backup, health,
  and rollback behavior unchanged.

## Acceptance

- The JIT runner is registered only to the private repository for one job and
  runs as a dedicated non-root service account.
- The official runner archive checksum is verified before extraction.
- The reviewed runner version and checksum are pinned in source.
- Root-owned cleanup runs after success, failure, interruption, or timeout.
- Launcher traps remove partial installation state before systemd takes
  ownership of cleanup.
- An exclusive launcher lock and per-invocation ownership flags make repeated
  or interrupted launches fail without deleting pre-existing runner state.
- The private-repository JIT label is dedicated to this manual production
  workflow. A repository collaborator could still add another job using the
  same label while the runner is waiting; repository access remains part of
  the accepted trust boundary.

## Validation evidence

- VPS double-launch regression: the launcher failed on an existing runner
  directory and preserved its sentinel file.
- Full tests, VPS production build, lint, Actionlint, Bash syntax, and diff
  validation pass locally.
- Strict review found a blocked HOME traversal permission and an insufficient
  lifetime cap; both were corrected before re-review.
- Follow-up review found stale operator and decision records; the GitHub VPS
  handoff now documents loopback, JIT generation, launch ordering, cleanup,
  and the single-use command-line exposure, while task 078 marks its earlier
  self-hosted-runner rejection as superseded.

## Release validation remaining

- Production `VPS_HOST` and its pinned host key were updated to loopback.
- The exact approved launcher generated one labeled repository JIT runner after
  the hosted build passed.
- Workflow run `30543311256` deployed exact merge
  `e0213e1351d79c97d71c724a580e9e9a050a166d`; public HTTPS, the OCI revision,
  container health, SQLite persistence, backup creation, and protected runtime
  entries passed.
- Automatic runner cleanup failed because the root-prefixed `ExecStopPost`
  process retained the service's filesystem namespace. Manual execution of the
  root-owned cleanup helper removed the runner state. Task 081 corrects and
  revalidates this path before task 080 is complete.
