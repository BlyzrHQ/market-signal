# Cancel the runaway Starter acceptance run

## Scope

Cancel only Trigger run `run_06g2r0ipft5dt1t004ibvao401`, created for the one authorized `myjam.co.uk` Starter acceptance report.

## Reason

The run produced 20 comparison pairs, then failed while persisting the public snapshot and automatically restarted from crawl. Re-running crawl and provider-backed stages would create unauthorized additional spend.

## Safety boundaries

- The workflow is branch-only and must not replace the normal acceptance launcher on `master`.
- It validates the exact deployed application revision, domain, plan, and run ID.
- It calls Trigger's official cancellation API through the SDK already present in the deployed application container.
- The server-owned Trigger secret remains inside the container and is never printed.
- It launches no report, evaluator, or provider-backed task.

## Validation

- Review the workflow diff for any report-dispatch call.
- Dispatch it once from this branch with the exact deployed revision, `myjam.co.uk`, and `starter`.
- Require a cancellation receipt for the exact run ID.
- Confirm the public report stops advancing and do not launch a replacement report.
