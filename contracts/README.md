# Market Signal contracts

These JSON Schemas are the language-neutral boundary between the hosted Market
Signal service, the Go CLI, and future crawler/comparison services.

- Additive optional fields may be added within a contract version.
- Removing, renaming, or changing the meaning of a field requires a new schema
  file and document version.
- Public facts, inferences, estimates, recommendations, coverage gaps, and
  provider access limits remain distinct in every version.
- A successful API response must validate before the CLI renders it. An API
  response outside the contract is a drift failure, not a partial success.

`report.v1.schema.json` describes the successful `/api/crawl` report response.
`evidence.v1.schema.json` documents the reusable evidence-record boundary.
## Contract inventory

- `report.v1.schema.json` validates the synchronous crawl/report response used
  by the legacy CLI commands.
- `report-result.v1.schema.json` validates the asynchronous loop status and
  bounded decision-ready response returned by `/api/reports/{publicId}/result`
  and consumed by `wait` and `result`.
