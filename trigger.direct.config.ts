import { defineConfig } from "@trigger.dev/sdk";
import base from "./trigger.config.ts";

const project = process.env.TRIGGER_PROJECT_REF?.trim();
if (!project) throw new Error("Set TRIGGER_PROJECT_REF to the operator's Trigger project before deploying");
// Include existing tasks so deploying to the company project does not retire
// its website tasks. Only direct tasks override retry/queue/duration settings.
export default defineConfig({ ...base, project, dirs: ["./src/trigger", "./src/trigger-direct"] });
