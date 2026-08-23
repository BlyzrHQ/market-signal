# Pair-based plan comparison delivery

## Objective

Restore the customer-facing plan contract so a delivered comparison is one
publishable primary-product/rival-product pair, not one distinct primary
product. Starter, Solo, Growth, and Agency target 20, 50, 500, and 1,000
published priced pairs respectively.

## Product contract

- Count every distinct, valid, target-market, price-backed rival pairing.
- Permit one primary product to contribute multiple distinct rival pairings.
- Order primary products deterministically by display name, then stable source
  identity, and consume their eligible rivals before advancing to the next
  primary product.
- Deduplicate canonical rival offerings and transitive aliases globally.
- Never count missing/invalid prices, unsupported currencies, inaccessible
  sources, or wrong-market evidence.
- Treat crawl/assessment totals as internal coverage, not delivered plan value.
- A target shortfall remains explicit; no fixture or fabricated pair may fill it.

## Scope

- Restore plan targets to 20 / 50 / 500 / 1,000.
- Change publication limiting, accumulation, completion checks, checkpoints,
  report metrics, and presentation to count pairs rather than primary rows.
- Preserve compatible reading of existing contract/checkpoint versions.
- Add scale tests through 1,000 pairs, multi-rival-per-primary tests,
  deterministic ordering tests, and alias/market/price exclusion tests.
- Validate against live MyJam reports for all four plans after deployment.

## Validation and rollout

- Focused tests, typecheck, production build, and full test suite.
- Strict verified Fable 5 exact-head review and merge gate.
- Deploy Trigger before the exact approved VPS revision.
- Run reports sequentially and record report URL, target, delivered pairs,
  distinct primary products, runtime, terminal state, and known AI cost.

## Cost boundary

Do not launch the four paid live reports until implementation, review, and
deployment are complete. Run them sequentially so a systemic failure can stop
the remaining spend.

## Review and validation record

- Fable 5 pre-implementation review required a new contract version, explicit
  row-versus-pair migration state, deterministic codepoint ordering, global
  rival alias collapse, and a 1,000-pair checkpoint proof. The implementation
  includes each requirement. Its first exact-head review reproduced a blocker
  where pair-mode retry evidence could contain more primary rows than the
  purchased target and fail checkpoint validation, identified a missing
  validator-side alias-integrity check, and required real checkpoint round-trip
  coverage at every plan size plus the byte-budget fallback. Evidence is now
  capped to the target while preserving selected rows and bounded backup rivals;
  pair validation re-runs global alias collapse; and those regression proofs are
  included. Exact-head re-review remains required.
- `npm test`: PASS — typecheck, Node typecheck, production build, and 1,095
  tests.
- `npm run lint`: PASS with two pre-existing `no-img-element` warnings and no
  errors.
- Focused lifecycle/orchestration suite: PASS — 174 tests, including exact
  20/50/500/1,000 checkpoint round trips with surplus primaries, duplicate-alias
  rejection, byte-budget fallback, and exact plan-sized pair output.
- Live paid reports remain intentionally unstarted until review and deployment
  complete.
