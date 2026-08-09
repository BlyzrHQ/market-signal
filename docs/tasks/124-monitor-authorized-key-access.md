# Task 124 — Monitor authorized-key access

## Problem

The first production installation of Task 123 correctly kept the monitor home,
SSH directory, and key file non-writable by `market-monitor`, but made
`.ssh` root-only mode `0700`. The VPS OpenSSH configuration reads
`AuthorizedKeysFile` after dropping to the target account, so authentication
failed with `Permission denied` before the forced command ran.

## Decision

Keep the home root-owned mode `0755`. Make `.ssh` root-owned with the
dedicated monitor group and mode `0750`, and make `authorized_keys`
root-owned with that group and mode `0640`. The account can traverse and read
only its key material but cannot modify the directory or key. The root-owned
non-Bash dispatcher, forced command, `restrict` key option, argument allowlist,
sudo boundary, and credential isolation remain unchanged.

## Rollout

1. Keep the currently inaccessible monitor account disabled in practice.
2. Merge the reviewed mode correction.
3. Remove only the failed monitor account/home installation, then reinstall
   from the exact merged scripts and the existing public key.
4. Verify health succeeds while arbitrary commands, malformed commands, PTY,
   forwarding, secret reads, and writes to `.ssh` or `authorized_keys` fail.
5. Create the recurring Codex automation only after those checks pass.

## Acceptance criteria

1. OpenSSH accepts the dedicated public key and runs only the forced health,
   claim, or exact ACK path.
2. `market-monitor` cannot alter its home, SSH directory, or authorized key.
3. The account is password-locked and is not a member of the Docker group.
4. Installer idempotence validates the exact readable/non-writable ownership
   and modes.
5. Full tests, VPS build, lint, strict review, PR, merge, deployment, and live
   adversarial checks pass.
