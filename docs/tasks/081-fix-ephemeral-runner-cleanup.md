# Task 081 — Fix ephemeral runner cleanup isolation

## Goal

Ensure the one-job VPS runner removes its work, credentials, account, unit, and
helper automatically after the GitHub job exits.

## Failure observed

Workflow run `30543311256` built and deployed merge
`e0213e1351d79c97d71c724a580e9e9a050a166d` successfully. GitHub deregistered
the JIT runner, but `market-signal-ephemeral-runner.service` ended failed and
left its runner directory, runtime HOME, service account, unit, and cleanup
helper behind.

The `+` command prefix restored root identity for `ExecStopPost`, but it did not
remove the unit's `ProtectSystem=strict` filesystem namespace. The cleanup
helper therefore could not write the account database or remove its unit and
helper files.

## Change

- Keep the runner process inside the existing restricted service.
- Have `ExecStopPost` ask PID 1 to run the root-owned cleanup helper in a
  separate, collected transient systemd service.
- Wait for that transient cleanup to finish so cleanup failure remains visible
  in the runner service result.
- Refuse a launch when the cleanup transient unit name is already present.
- Keep the helper's existing idempotent, root-owned removal behavior.

## Acceptance

- A sandboxed parent service can launch the cleanup transient through
  `systemd-run`.
- The cleanup transient does not inherit the runner service's filesystem
  namespace restrictions.
- Success and failure paths remove the runner directory, runtime HOME, user,
  group, parent unit, and helper.
- The transient cleanup unit is collected after it exits.
- Static tests, shell syntax, the full suite, strict Fable 5 review, and one
  real one-job deployment pass before completion.
