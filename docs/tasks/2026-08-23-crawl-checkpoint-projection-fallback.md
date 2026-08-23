# Crawl checkpoint projection fallback

## Problem

A live `myjam.co.uk` Starter pilot completed its crawl but every Trigger attempt failed before matching with `The successful crawl could not be projected into a durable checkpoint.` The checkpoint path always compacted the presentation document to 650 KB even when the already-bounded crawl snapshot would fit the durable compressed checkpoint budget losslessly.

## Contract

- Prefer the bounded, lossless crawl snapshot when it fits both the 16 MiB recovery ceiling and the durable compressed result ceiling.
- Use presentation compaction only when the lossless snapshot does not fit the compressed result ceiling.
- Continue to fail closed when neither representation fits; never discard matching state or silently publish partial facts.
- Prove that a presentation document which cannot satisfy the 650 KB presentation target can still checkpoint when its lossless compressed snapshot fits.

## Validation

- Focused orchestration regression tests.
- Full test, typecheck, lint, and production build.
- Strict exact-head Fable 5 review.
- Trigger-first deployment followed by the exact merged application commit.
- Fresh real-domain `myjam.co.uk` Starter report before larger plan proofs.
