import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("open-source onboarding files and commands stay connected", () => {
  const packageJson = JSON.parse(read("package.json"));
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");
  const license = read("LICENSE");

  assert.equal(packageJson.scripts["test:open-source"], "node scripts/verify-open-source-setup.mjs");
  assert.match(readme, /npm ci/);
  assert.match(readme, /npm run test:open-source/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(contributing, /without private credentials/i);
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
  assert.equal(packageJson.license, "Apache-2.0");
});

test("contributor CI is read-only, secret-free, and runs the documented checks", () => {
  const workflow = read(".github/workflows/contributor-ci.yml");

  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run test:open-source/);
  assert.match(workflow, /npm run trigger:dev -- --help/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /go -C cli test \.\/\.\.\./);
  assert.match(workflow, /go -C cli vet \.\/\.\.\./);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@(?![a-f0-9]{40}(?:\s|$))/);
});

test("Vite leaves the native SQLite driver external to SSR", () => {
  const vite = read("vite.config.ts");
  assert.match(vite, /ssr:\s*{\s*external:\s*\["better-sqlite3"\]/s);
});

test("open-source Trigger configuration belongs to the installer", () => {
  const config = read("trigger.config.ts");
  const example = read(".env.example");
  const guide = read("docs/OPEN_SOURCE_SETUP.md");

  assert.match(config, /TRIGGER_PROJECT_REF/);
  assert.doesNotMatch(config, /project\s*:\s*["']proj_(?!replace_with_your_own)[A-Za-z0-9]+["']/);
  assert.match(example, /^TRIGGER_PROJECT_REF=$/m);
  assert.match(example, /^TRIGGER_API_URL=$/m);
  assert.match(guide, /own Trigger\.dev Cloud project/);
  assert.match(guide, /own self-hosted Trigger\.dev instance/);
  assert.match(guide, /no hosted fallback/);
});
