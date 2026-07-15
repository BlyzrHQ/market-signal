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
`ads.v1.schema.json` describes the successful `/api/ads` response.
`evidence.v1.schema.json` documents the reusable evidence-record boundary.
