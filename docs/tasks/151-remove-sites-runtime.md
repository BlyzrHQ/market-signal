# Task 151: remove the obsolete Sites runtime

## Objective

Make the supported production architecture unambiguous: the web application
runs on the VPS at `signal.blyzr.com`, while Trigger.dev owns durable background
orchestration. Remove the former OpenAI Sites build, deployment, identity, and
edge-recovery paths.

## Scope

- Remove `.openai/hosting.json`, the Sites packaging plugin, and Cloudflare-only
  build/runtime shims that existed for the Sites deployment.
- Remove hard-coded `chatgpt.site` crawl and product-enrichment fallbacks.
- Remove trust for platform-injected ChatGPT identity headers; standalone
  accounts remain the only browser identity boundary.
- Update active deployment configuration, scripts, contribution rules, and
  launch documentation for Trigger plus the VPS.
- Preserve old task documents as historical release evidence.

## Acceptance

- No active source, configuration, workflow, or current operations document
  depends on `.openai/hosting.json`, `chatgpt.site`, or the Sites Vite plugin.
- The Node/VPS build, full test suite, lint, and Go CLI checks pass.
- A strict verified Fable 5 review reports no blockers on the exact PR head.
- Trigger is deployed before the same approved revision is deployed to the VPS.
- The live application and a real public-domain report are verified at
  `https://signal.blyzr.com` without a Sites fallback.

## Data-source boundary

Removing Sites does not broaden scraping. Public-source collection remains
bounded, robots-aware, and attributable. Official storefront adapters such as
the public Salla MCP catalog remain available when their eligibility checks
pass.
