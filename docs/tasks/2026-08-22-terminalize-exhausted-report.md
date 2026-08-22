# Terminalize exhausted report processing

## Problem

A production Babanuj canary on Trigger `20260822.2` preserved its successful crawl through a later HTTP 403, but product matching exhausted the final bounded task attempt without any publishable rows. The Trigger run failed while the customer-facing report remained `running`, leaving no honest terminal result.

## Required behavior

- A final bounded task attempt must publish the strongest verified facts collected so far as a `limited` report, even when no product-comparison row survived.
- The report must visibly retain the matching coverage gap and must not invent comparisons.
- Non-final attempts continue to retry from durable checkpoints.
- Validate the focused orchestration suite, full repository suite, production build, and a real public-domain canary.

## Production evidence

- Report: `cc9199fb3d6e4a85bbe95bae596c3774`
- Trigger run: `run_06g2ltnnke49ilg72062s7rl01`
- The durable crawl resumed after a later HTTP 403 with 80 primary products and 20 verified competitors.
- Matching exhausted task attempt 10, Trigger failed, and the stored report remained `running`.
