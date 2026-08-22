# Publish durable matcher recovery

## Problem

A final orchestration task can lose both live matcher calls even though an earlier bounded task already persisted a validated published-result checkpoint. The final gate currently considers only matcher responses parsed during the current task, so it discards the durable verified result and fails the report.

## Change

- Adopt a validated durable published-result checkpoint when the current task has no parsed matcher response.
- Treat that checkpoint as proof that at least one earlier matcher response was parsed and passed the publication boundary.
- Preserve the fail-closed behavior when neither a current response nor a validated durable published result exists.

## Validation

- Add a regression covering a successful earlier matcher task followed by total matcher transport failure on the final task.
- Retain the total matcher failure regression with no durable evidence.
- Run the focused orchestration tests, full test suite, type checks, and production build.
- Verify against a real production domain after deployment.

