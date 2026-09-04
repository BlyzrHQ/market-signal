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

Replace **every** angle-bracket placeholder with your own input. No store domain
or sample report is prefilled. Counts mean priced comparison pairs, not catalog
size; the rival count is a maximum of distinct sellers in the returned pairs.

```powershell
marketsignal-trigger report "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>"
```

The command submits to Trigger, prints the run ID on stderr, polls, and writes
the final JSON on stdout. The report task runs the existing crawler/recovery,
direct product search, price extraction, deterministic recommendations and
quality gate inside Trigger. No VPS callbacks or database are required.

Other research commands:

```powershell
marketsignal-trigger crawl "<domain>" --comparisons 20 --request-id "<unique-request-id>"
marketsignal-trigger compare "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>"
```

`crawl` returns public catalog data; its count limits returned catalog products.
`compare` crawls and searches priced matches but omits recommendation generation.
`report` includes comparisons, competitor roll-ups and recommendations.
These are independent new runs; calling all three repeats research work.

## Resume and retrieve; do not start another paid run

```powershell
marketsignal-trigger report "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>" --no-wait
marketsignal-trigger wait "<run-id>"
marketsignal-trigger result "<run-id>"
```

`wait` and `result` only read Trigger. An interrupted wait does not cancel the
task. Use the returned run ID. Submissions are not automatically retried. If a
submission's outcome is unknown, inspect Trigger first; do not generate another
request ID. Trigger's requested deduplication TTL is 24 hours, not permanent.
Never reuse an ID for different input or assume replay is safe after the TTL.

## Output

The CLI returns a Trigger envelope with `id`, `status`, `taskIdentifier`, `output`.
When Trigger offloads larger output, the CLI downloads its signed artifact over
HTTPS with a 16 MiB limit, without forwarding the Trigger key or printing the
signed URL. Private-network targets and redirects are refused.
For reports, `output` includes:

- `request`: domain, comparison target, rival limit and correlation ID.
- `comparisons`: primary/rival product records with price, currency, source URL,
  observation time, inferred match assessment and optional recommendation.
- `competitors`: sellers derived from the returned comparisons and pair counts.
- `metrics`: requested/delivered comparisons, catalog/search counts.
- `evaluation`: explicitly labeled deterministic quality-gate verdict.
- `limitations` and `costMicrousd`: unknown cost is null, never zero.

A completed Trigger run can contain a **limited** report. Targets are not a
guarantee of that many valid matches. The standalone version performs one bounded
search pass (up to 100 new primary searches and eight minutes); automatic repair,
independent AI recall evaluation, report sharing, account billing and price-watch
administration are not part of these direct tasks. No empty prices are published.

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
