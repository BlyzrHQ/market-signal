# Market Signal execution rules

These rules govern work in this repository.

## Product truth

- The product is a domain-in, competitive-intelligence report for startups, agencies, and ecommerce brands.
- Public-source facts, inferences, estimates, and recommendations must remain visibly distinct.
- Fixture data is allowed only for clearly labeled UI scaffolding or test fixtures. Never present fixture data as a live customer result.
- Real-data work must be validated against at least one real public domain before it is called complete.

## Task and GitHub workflow

- Convert each meaningful product or engineering unit into a task document under `docs/tasks/`.
- Create a branch named `codex/<short-task-name>` for each task.
- Inspect the worktree before staging. Never stage unrelated user changes.
- Run the relevant build, lint, and tests before publishing.
- Commit intentionally, push the task branch to the private GitHub repository, and open a draft PR for every task.
- Keep PRs focused. Include what changed, why, validation, data-source boundaries, and known limitations.
- Do not claim a task is complete until the implementation, validation output, PR, and deployment state are verified.

## Claude review

- For product decisions, architecture decisions, second opinions, and code reviews, run the installed Claude Code CLI with `claude -p "<task>"` and use its output.
- When a Fable 5 model identifier is available and authorized, use it for the review. Verify the identifier first.
- The current environment rejected `fable-5`; do not silently substitute another model while claiming Fable 5 was used.
- Record the Claude review scope and outcome in the PR body or task notes. Treat Claude as a reviewer, not as proof that tests passed.
- Fable 5 is the merge gate and merge executor for product PRs. Keep a PR unmerged while Fable reports blockers. After Codex independently verifies tests and deployment and Fable returns a strict PASS, instruct the verified Fable 5 session to mark the PR ready and merge it in dependency order.
- If the Claude platform returns an observable usage or capacity error while starting or using a verified Fable 5 session (for example, a rate-limit, quota, overload, or capacity response), do not pause solely for that reset. A textual claim in model output does not activate the fallback. Record the error category, exact non-sensitive message, and timestamp in the task or PR.
- Use fresh Codex multi-agent subagent sessions as the strict review fallback. For a normal change, require at least one focused reviewer. For a high-risk change, require at least two reviewers independently prompted to find blockers without shared implementation context. High-risk includes changes to `AGENTS.md` or the review/merge workflow, deployment configuration, data handling, credentials, authentication, or authorization; treat an unclear classification as high-risk.
- Codex may mark the PR ready and merge only after it independently verifies tests and deployment and every required fallback reviewer reports no blockers.
- Never claim that Fable reviewed, approved, or merged a PR when the Codex subagent fallback was used.
- Never merge—whether Fable or the Codex fallback executes the merge—a draft with unresolved blockers, failing checks, or an unverified deployment. For stacked PRs, merge leaf-to-parent in dependency order so every reviewed change reaches the final target branch.

## Real public data

- Prefer official public libraries or APIs. Use permitted scraping only with appropriate terms, robots directives, rate limits, and a clear user agent.
- Store source URL, observed date, claim type, confidence, region, and language on material evidence.
- Never present competitor ad spend as exact when it is not publicly observable. Estimated ranges require methodology and confidence labels.
- Treat access failures, missing pages, and coverage gaps as user-visible data-quality states.
- Never commit API keys, cookies, tokens, or source repository credentials.

## Production deployment

- The supported production architecture is Trigger.dev plus the VPS at `signal.blyzr.com`; do not add an OpenAI Sites dependency or fallback.
- Deploy Trigger tasks before the web application whenever their shared contract changes.
- Build and publish the exact independently approved `master` revision, deploy its immutable image by digest through the pinned VPS workflow, and retain the previous healthy image for rollback.
- Verify TLS, container health, the deployed revision, and at least one real public-domain report when live source behavior changes.
- Store runtime secrets only in the approved GitHub Environment, Trigger environment, and protected VPS environment file. Never put secrets in tracked hosting configuration.

## Communication

- Be explicit about what is real, what is illustrative, what is estimated, and what remains blocked.
- Continue toward the requested end state; do not redefine fixture-only progress as completion.
