# Market Signal — direct Trigger CLI

Install the CLI, configure your company's Trigger environment API key, and run
research tasks directly in Trigger. No Market Signal website login, workspace
credential, or customer quota is involved.

**[Installation and command instructions](docs/direct-trigger-cli.md)**

```powershell
marketsignal-trigger configure
marketsignal-trigger doctor
marketsignal-trigger report "<domain>" --comparisons 20 --rivals 5 --request-id "<unique-request-id>"
```

Replace every placeholder with your own input. No test store is prefilled.
The comparison count means priced product/rival pairs, not catalog size.
JSON includes comparisons, rivals, evidence, quality checks, and limitations.
The CLI defaults to core comparisons plus deterministic guidance. Optional AI
recommendations and rival website scoring require `--include-analysis`; they
increase latency and may add provider cost. The output explicitly marks these
extras as not requested when omitted. Use the matching worker from this branch.
The report command shows progress and returns its result automatically. Keep it
open; `wait` is only for recovering an interrupted session or explicit background
mode. The two-minute completed-report target is under validation, not guaranteed.

The operator first deploys the direct tasks and sets research-provider
credentials in the company Trigger environment. Colleagues only need the
installed executable and their Trigger environment key after that setup.
Download the matching binaries from the **Direct Trigger CLI** GitHub Actions
artifact for the reviewed commit, or get the ZIP from your company operator.

This branch is independent of the website/customer CLI workflow. The existing
website source remains in the repository but is not used by this executable.
See the guide for the precise validation and deployment boundary; a successful
local test is not proof that the new tasks are installed in your project.

## Loop graph

The first loop runs inside the direct Trigger report task. It can repair the
current draft before returning structured results to the calling CLI or agent.
The second loop is the **future design only: the coding agent is deferred and
is not connected or enabled**. It must not delay a report response or rewrite
an already completed report.

```mermaid
flowchart TD
    REQUEST["CLI or calling agent<br/>Domain + comparison target + rival cap"]
    REQUEST --> VALIDATE["Validate request and Trigger access"]
    VALIDATE --> CRAWL

    subgraph REPORT["Current report loop - inside Trigger"]
        CRAWL["Crawl public product pages<br/>Collect catalog and source evidence"]
        CRAWL --> SEARCH["Search for comparisons for individual products"]
        SEARCH --> RETRIEVE["Read rival product pages<br/>Extract attributable prices and evidence"]
        RETRIEVE --> DRAFT["Compose draft comparison rows<br/>Apply publication rules and rival cap"]
        DRAFT --> QUALITY["Deterministic quality check<br/>Count, prices, currencies, sources and duplicates"]
        QUALITY --> ENOUGH{"Target met after<br/>invalid rows are removed?"}
        ENOUGH -- Yes --> READY["Comparison target satisfied"]
        ENOUGH -- No --> REPAIR{"Repair available?<br/>At most 3 rounds per attempt"}
        REPAIR -- Yes --> FEEDBACK["Save targeted repair feedback<br/>Name products and exclude accepted rival URLs"]
        FEEDBACK --> SEARCH
        REPAIR -- No --> LIMITED["Retain valid comparisons only<br/>Mark limited and record exact shortfall"]
        READY --> COMPLETE["Retain deterministic guidance<br/>Optional AI recommendations and rival scores only when requested"]
        LIMITED --> COMPLETE
        COMPLETE --> SAVE["Persist immutable report facts<br/>Comparisons, rivals, evidence and limitations"]
    end

    SAVE --> OUTPUT["Return structured JSON through CLI<br/>Report status, results and quality history"]
    OUTPUT --> DONE["Caller receives result - invocation ends"]

    SAVE -. "Future handoff - not connected" .-> EVALUATE
    subgraph FUTURE["Deferred second loop - not implemented as an autonomous worker"]
        EVALUATE["Evaluate completed report<br/>Identify evidence-linked weaknesses"]
        EVALUATE --> ISSUE{"Approved improvement issue?"}
        ISSUE -- No --> STOP["Stop and retain current version"]
        ISSUE -- Yes --> AGENT["Coding agent on a separate development worker<br/>Create candidate fix on an isolated branch"]
        AGENT --> TEST["Run tests and fixed benchmark<br/>Compare candidate against stored baseline"]
        TEST --> METRIC{"Measurably better<br/>and all safeguards pass?"}
        METRIC -- Yes --> KEEP["Keep candidate for independent review<br/>Normal approval and deployment gates still apply"]
        METRIC -- No --> REJECT["Reject candidate<br/>Keep approved baseline unchanged"]
        METRIC -- "Unknown or incomparable evidence" --> HUMAN["Stop for human review"]
        REJECT --> RETRY{"Attempts, time and budget remain?<br/>Maximum 3 distinct candidates"}
        RETRY -- Yes --> AGENT
        RETRY -- No --> STOP
        KEEP --> APPROVED["Only after approval and verified deployment<br/>New version can serve future requests"]
    end
    APPROVED -. "Future requests only - never rewrite saved reports" .-> CRAWL
```

### What is working now

- A comparison is a priced primary-product/rival-product pair, not a crawled
  catalog entry. A primary product can contribute multiple distinct rival pairs.
- The current quality gate checks structural publication rules. Passing it is
  **not** a guarantee of an identical SKU, equivalent pack size, or perfect
  semantic relevance; alternative matches remain inferences.
- Repair feedback targets named products and avoids already accepted rival
  source URLs. It is scoped to the current report, not learning shared across
  future reports.
- Three quality-repair rounds are the maximum **per orchestration attempt**,
  separate from bounded Trigger retries and continuation passes. The diagram
  focuses on report quality, not every transport, access or persistence failure.
  A met comparison target does not erase other report limitations.
- Durable operation receipts and checkpoints avoid repeating completed work;
  ambiguous paid operations stop further paid work. A null AI cost is unknown,
  never zero. Limits and cost caveats are in the [CLI guide](docs/direct-trigger-cli.md).

### What stays for later

The repository already contains a graph contract and pure metric-gate decision
logic, but they do not constitute a deployed, self-improving coding agent. The
deferred design compares relevance, coverage, price/source validity, cost and
runtime against a fixed baseline; it keeps a candidate only through the normal
review and deployment process. Unknown evidence requires human judgment.

Hosting, subscription authentication and unattended-use permissions for the
separate coding worker remain future decisions. This README does not install a
worker, schedule coding jobs, enable paid evaluations or authorize automatic
merges. The current loop improves a report within its bounded run; it does not
change the software or learn between reports on its own.

Implementation references:

- [Shared report orchestration](src/trigger/report-orchestration-core.ts)
- [Direct Trigger workflow runtime](src/trigger-direct/workflow-runtime.ts)
- [Report quality gate and repair feedback](src/shared/report-quality-gate.ts)
- [Graph contract, including the deferred path](src/shared/market-signal-loop-graph.ts)
- [Pure improvement metric gate](src/shared/market-signal-improvement-gate.ts)

Developer checks (not required on a colleague's machine): `npm ci`,
`npm run test:open-source`, `npm test`, and `go -C cli test ./...`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for repository development rules.
