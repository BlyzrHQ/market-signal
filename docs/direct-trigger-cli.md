# Direct Trigger CLI — colleague handoff

This CLI connects to **your Trigger project**, not to the Market Signal website.
It submits installed tasks to `api.trigger.dev` and retrieves their structured
output. It has no Market Signal browser login, workspace credential, customer
plan or daily quota. The private Trigger environment key selects the environment.

## One-time company setup (operator, not every colleague)

The new tasks must be deployed before colleagues can run them. A runtime Trigger
environment key alone does not install task code. The operator needs deployment
access plus the project ref, and configures `OPENAI_API_KEY` in that Trigger
environment for product web search. Colleagues do not need the research key.

From this branch with Node 22.13+:

```powershell
npm ci
npx trigger.dev@4.5.4 login
$env:TRIGGER_PROJECT_REF = "<project-ref>"
npx trigger.dev@4.5.4 deploy --config trigger.direct.config.ts
```

Verify the chosen project/environment in the deployment prompt. This config
includes the existing website tasks as well as the new direct tasks, so it does
not retire existing tasks in the same project. The website itself is not deployed
or changed by this command. Never use the old VPS orchestration task as the
direct report entry point; that older task still depends on website callbacks.

For branch acceptance testing without changing the active website worker, deploy
with `--skip-promotion`, then pass `--worker-version "<deployed-version>"` to CLI
commands. This pins new submissions to that version. Omit it only after the
operator has promoted an approved version. `result` and `wait` always retrieve
the original run and do not change its version.
The CLI checks the version reported by Trigger once assigned; a mismatch is an
error, not a successful acceptance test. Inspect that run before resubmitting.

## Install (colleagues)

The operator supplies the ZIP from the **Direct Trigger CLI** GitHub Actions run
for the reviewed commit. The private-repository artifact requires GitHub access
to download, not a Market Signal account. Downloading a branch alone does not
mean its tasks are deployed. The package is not code-signed; obtain it only from
your company operator. Checksums detect corruption, not an untrusted distributor.

Windows: extract the ZIP and run `./install.ps1` in PowerShell from that folder.
This installs `marketsignal-trigger` on your user PATH. No Go or Node is needed.
Linux/macOS: select the matching binary, verify it against SHA256SUMS, make it
executable and place it on PATH under `marketsignal-trigger`. Linux secret
storage requires a working desktop Secret Service; headless agents can use the
environment variable instead.

For developers only, source build from the repository root:

```powershell
go -C cli build -o ../marketsignal-trigger.exe ./cmd/marketsignal-trigger
.\marketsignal-trigger.exe version
```

## Connect your Trigger key once

```powershell
marketsignal-trigger configure
```

The hidden prompt accepts your **private Trigger environment API key**. The CLI
checks it against Trigger and stores it in a separate operating-system credential
store. No key goes in command arguments, JSON report input, the repository, or
the Market Signal website. Agents can instead receive `TRIGGER_SECRET_KEY`
through their secret manager; it overrides the stored key. Do not paste keys in
chat. A private key can access other tasks in its environment: give it only to
trusted colleagues/agents and rotate any exposed key.

```powershell
marketsignal-trigger doctor
marketsignal-trigger tools
```

These run the installed capabilities task. They make no research-provider calls,
but Trigger compute charges may apply. Check `providerConfigured` in the JSON.
HTTP 404 means the direct task is not installed in the key's environment; a
successful key check alone does not prove task deployment.

## Generate a report

With this branch's CLI and worker, the default returns core comparisons,
competitors, evidence and deterministic guidance. Add `--include-analysis` to
also request AI recommendations and rival website scores. That optional work
adds latency and may add provider cost; it is not silently queued in background.
JSON `optionalAnalysis` reports what was requested. Requests from older clients
that omit the `includeAnalysis` field keep legacy behavior; they do not acquire
the faster default automatically. Use a new request ID when changing this flag.
Deploy the matching worker before distributing this executable.

Replace **every** angle-bracket placeholder with your own input. No store domain
or sample report is prefilled. Counts mean priced comparison pairs, not catalog
size; the rival count is a maximum of distinct sellers in the returned pairs.

```powershell
marketsignal-trigger report "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>"
```

The command submits to Trigger, immediately says **Report incoming**, prints
elapsed-time progress on stderr, and writes the final JSON on stdout. Leave this
one command open: **no separate `wait` command is needed**. Redirecting stdout to
a JSON file still leaves progress visible in your terminal.

The report task runs the existing crawler/recovery,
direct product search, final price recovery, quality repair, AI-grounded actions
with deterministic fallback, and rival experience benchmarks inside Trigger.
It calls the same report orchestration engine as the website. No VPS callbacks,
website login, or external database are required.

Other research commands:

```powershell
marketsignal-trigger crawl "<domain>" --comparisons 20 --request-id "<unique-request-id>"
marketsignal-trigger compare "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>"
```

`crawl` returns public catalog data; its count limits returned catalog products.
`compare` and `report` both run the complete shared report workflow, including
comparisons, competitor roll-ups and recommendations.
These are independent new runs; calling all three repeats research work.

## Optional background mode and interrupted-session recovery

```powershell
marketsignal-trigger report "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>" --no-wait
marketsignal-trigger wait "<run-id>"
marketsignal-trigger result "<run-id>"
```

Use `--no-wait` only when you explicitly want a background submission. It is not
part of the normal report command. `wait` and `result` only read Trigger. An interrupted wait does not cancel the
task. Use the returned run ID. Submissions are not automatically retried. If a
submission's outcome is unknown, inspect Trigger first; do not generate another
request ID. Trigger's requested deduplication TTL is 24 hours, not permanent.
Never reuse an ID for different input or assume replay is safe after the TTL.

## Output

The CLI returns a Trigger envelope with `id`, `status`, `taskIdentifier`, `output`.
When Trigger offloads larger output, the CLI downloads its signed artifact over
HTTPS with a 16 MiB limit, without forwarding the Trigger key or printing the
signed URL. Private-network targets and redirects are refused.
It unwraps Trigger's superjson storage envelope for this plain-JSON contract;
unexpected typed metadata or content types fail closed.
For reports, `output` includes:

- `request`: domain, comparison target, rival limit and correlation ID.
- `comparisons`: primary/rival product records with price, currency, source URL,
  observation time, inferred match assessment and optional recommendation.
- `competitors`: sellers derived from the returned comparisons and pair counts.
- `metrics`: requested/delivered comparisons, catalog/search counts.
- `evaluation`: explicitly labeled deterministic quality-gate verdict.
- `facts`: the complete authoritative company/product/match facts, not a UI preview.
- `report`, `benchmarks`, `progress`: structured presentation, measured rival
  experience coverage, and the recorded stage/repair history.
- `limitations` and `costMicrousd`: unknown cost is null, never zero.

A completed Trigger run can contain a **limited** report. Targets are not a
guarantee of that many valid matches. The shared engine can resume up to ten
bounded attempts, with up to 100 new primary searches per ordinary matching pass
and up to three quality-repair rounds per attempt. This can cost more than the
previous single-pass CLI: start with a small target and inspect usage. No empty
prices are published. Independent post-publication AI recall evaluation, report
sharing, account billing and price-watch administration are not automatically run.

Checkpoints are compressed snapshots in a separate Trigger task queue, with a
small, explicitly flushed pointer on the parent run. Saves are serialized and
bound to the run and input. Trigger storage/compute charges and retention apply.
Snapshots stop at 64 MiB uncompressed or 8 MiB encoded; they never truncate facts.
If a provider response or durable save is ambiguous, the task stops before more
paid work rather than automatically repeating the request. Inspect that run.

Parity means shared research/quality code, not identical live web responses:
Trigger's network can receive a different response from a site's VPS request.
The CLI accepts an arbitrary bounded pair target and a seller cap; website plans
remain unchanged. Cross-report competitor memory is not shared with the website.

Exit codes: `0` success, `1` invalid input/configuration/transport, `2` limited
report, `5` failed run/report, `6` pending (resume by run ID), `9` request-ID/input
conflict or unverifiable submission payload. stdout is JSON for
run commands; setup confirmations and version output are plain text.

## Validation boundary

Local unit/contract tests use injected synthetic fixtures and do not spend
research credits. An actual deployed report must be tested separately before
the operator calls the installation production-ready. No live report example
is embedded in this guide.

API references: [trigger a task](https://trigger.dev/docs/management/tasks/trigger),
[retrieve a run](https://trigger.dev/docs/management/runs/retrieve),
[idempotency](https://trigger.dev/docs/idempotency).
