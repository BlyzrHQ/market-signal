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

## Real public data

- Prefer official public libraries or APIs. Use permitted scraping only with appropriate terms, robots directives, rate limits, and a clear user agent.
- Store source URL, observed date, claim type, confidence, region, and language on material evidence.
- Never present competitor ad spend as exact when it is not publicly observable. Estimated ranges require methodology and confidence labels.
- Treat access failures, missing pages, and coverage gaps as user-visible data-quality states.
- Never commit API keys, cookies, tokens, or source repository credentials.

## Sites deployment

- Keep `.openai/hosting.json` in sync with the Sites project identity; do not store runtime secrets there.
- Build the exact validated source, push that commit to the Sites source repository, package it, save a version, and deploy privately.
- Verify deployment status and report the live private URL.
- If live source behavior changes, redeploy and verify the deployed endpoint, not only the local preview.

## Communication

- Be explicit about what is real, what is illustrative, what is estimated, and what remains blocked.
- Continue toward the requested end state; do not redefine fixture-only progress as completion.
