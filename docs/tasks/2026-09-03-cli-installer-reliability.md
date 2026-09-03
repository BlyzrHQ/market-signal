# CLI installer reliability

## Goal

Make the documented Windows PowerShell installation command recover from transient download or file-hash failures and return an actionable error instead of a raw null-method exception.

## Scope

- Retry the CLI binary and checksum-manifest downloads up to three times.
- Reject empty downloads before attempting integrity verification.
- Retry SHA-256 calculation and explicitly reject an absent or empty hash result.
- Preserve HTTPS/loopback URL restrictions, bounded download sizes, checksum verification before installation, and temporary-file cleanup.

## Validation

- Run the focused CLI distribution tests.
- Run the full Node test suite, lint, typecheck, production build, and VPS build.
- Execute the local installer with Windows PowerShell 5.1 into an isolated directory.
- Execute the documented production one-liner with Windows PowerShell 5.1 after deployment.
- Obtain strict exact-head Fable review before merge and deploy the exact merge commit through the protected VPS workflow.

## Data and cost boundary

This task downloads only the public installer, checksum manifest, and CLI binary. It does not create reports, call paid comparison models, or consume customer credits.
