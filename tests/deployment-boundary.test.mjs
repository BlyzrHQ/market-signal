import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const activeFiles = [
  "AGENTS.md",
  "README.md",
  "docs/LAUNCH.md",
  "compose.yaml",
  "deploy/vps/README.md",
  "deploy/vps/market-signal.env.example",
  "package.json",
  "vite.config.ts",
];

test("active runtime and operations files contain no retired Sites dependency", () => {
  assert.equal(fs.existsSync(path.join(root, ".openai", "hosting.json")), false);
  assert.equal(fs.existsSync(path.join(root, "build", "sites-vite-plugin.ts")), false);
  for (const file of activeFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /chatgpt\.site|\.openai\/hosting\.json|sites-vite-plugin/i, file);
  }
});
