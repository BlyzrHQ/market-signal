# Task 002 — Evidence policy and source-adapter contract

## Goal

Define the evidence and source boundaries for the first Meta, Google, and TikTok monitoring release so the product can be useful without presenting estimates as facts.

## Scope

- Normalize provider output into a shared evidence record.
- Document `observed`, `inferred`, `estimated`, and `recommended` claim types.
- Require source URL, observed date, confidence, region, and language on material claims.
- Define spend-estimate labeling and methodology requirements.
- Record per-platform access method, coverage limits, and rate-limit posture.
- Define automatic competitor discovery confidence and visible rationale.

## Acceptance criteria

- `docs/product-contract.md` reflects the resolved MVP decisions.
- The evidence schema is explicit and provider-neutral.
- Estimated spend is always shown as a range with confidence and methodology.
- Meta, Google, and TikTok are named as the first channels.
- The paid-provider budget remains the only open data-source decision.
- The project still builds successfully with the Sites/Vinext toolchain.

## Next task

Task 003 should build the domain intake and first interactive report using a small, inspectable fixture dataset that exercises the evidence schema before live collectors are added.
