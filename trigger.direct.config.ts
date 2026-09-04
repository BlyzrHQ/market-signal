import { defineConfig } from "@trigger.dev/sdk";
import base from "./trigger.config.ts";

// The CLI resolves the real project before uploading. Trigger's remote indexer
// imports this module without the operator's shell environment; do not throw
// there. Without local configuration, the base placeholder is not deployable.
const project = process.env.TRIGGER_PROJECT_REF?.trim() || base.project;
// Include existing tasks so deploying to the company project does not retire
// its website tasks. Only direct tasks override retry/queue/duration settings.
export default defineConfig({ ...base, project, runtime: "node-22",
  // esbuild turns a bundled CJS dynamic import into a default-only namespace.
  // public-fetch needs undici's named Agent/fetch exports at runtime.
  build: { ...base.build, external: [...(base.build?.external || []), "undici"] },
  dirs: ["./src/trigger", "./src/trigger-direct"] });
