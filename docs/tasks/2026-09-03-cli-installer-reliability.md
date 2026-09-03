# CLI installer reliability

## Goal

Make the documented Windows PowerShell installation command recover from transient download or file-hash failures and return an actionable error instead of a raw null-method exception.

## Reproduced cause

Windows PowerShell 5.1 on the affected machine does not expose `Get-FileHash`. The prior chained expression continued with a null command result and surfaced `You cannot call a method on a null-valued expression`, obscuring the missing-cmdlet failure. A separate fault test also showed that a non-empty truncated response was rejected but not retried.

## Scope

- Retry binary download, manifest download, manifest parsing, and SHA-256 verification together as one bounded three-attempt transaction.
- Reject empty, oversized, malformed, corrupted, or truncated downloads before installation.
- Compute SHA-256 through the .NET cryptography API so the installer works even when `Get-FileHash` is unavailable, and reject an invalid hash result.
- Keep installer helper functions scoped so the documented `irm ... | iex` command does not overwrite functions in the caller's session.
- Preserve HTTPS/loopback URL restrictions, bounded download sizes, checksum verification before installation, and temporary-file cleanup.

## Validation

- Run the focused CLI distribution tests.
- Run the full Node test suite, lint, typecheck, production build, and VPS build.
- Execute the local installer with Windows PowerShell 5.1 into an isolated directory.
- Exercise corrupted-binary, malformed-manifest, permanent-checksum-failure, cleanup, and existing-install preservation behavior under Windows PowerShell 5.1.
- Execute the documented production one-liner with Windows PowerShell 5.1 after deployment.
- Obtain strict exact-head Fable review before merge and deploy the exact merge commit through the protected VPS workflow.

## Data and cost boundary

This task downloads only the public installer, checksum manifest, and CLI binary. It does not create reports, call paid comparison models, or consume customer credits.
