import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("VPS image and compose keep the app private and persistent", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("compose.yaml");

  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
  assert.match(dockerfile, /node_modules\/vinext\/dist\/cli\.js/);
  assert.match(dockerfile, /MARKET_SIGNAL_SQLITE_PATH=\/data\/market-signal\.sqlite/);
  assert.match(compose, /\/var\/lib\/market-signal:\/data/);
  assert.match(compose, /\/var\/backups\/market-signal:\/backups/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /expose:\s*\n\s*- "3000"/);
  assert.doesNotMatch(compose, /app:[\s\S]*?ports:\s*\n\s*-\s*["']?\d+:3000/);
  const caddyService = compose.split(/\r?\n  caddy:\r?\n/)[1];
  assert.ok(caddyService);
  assert.doesNotMatch(caddyService, /env_file:/);
  assert.match(caddyService, /MARKET_SIGNAL_DOMAIN:/);
});

test("runtime dependencies required by vinext are installed in production", () => {
  const manifest = JSON.parse(read("package.json"));
  for (const name of [
    "vinext",
    "vite",
    "@vitejs/plugin-react",
    "@vitejs/plugin-rsc",
    "react-server-dom-webpack",
  ]) {
    assert.ok(manifest.dependencies[name], `${name} must be a runtime dependency`);
    assert.equal(manifest.devDependencies[name], undefined);
  }
});

test("example environment contains placeholders rather than credential values", () => {
  const example = read("deploy/vps/market-signal.env.example");
  assert.match(example, /MARKET_SIGNAL_DOMAIN=staging\.example\.com/);
  assert.match(example, /MARKET_SIGNAL_CALLBACK_TOKEN=replace-with/);
  assert.doesNotMatch(example, /\b(?:sk-proj-|tr_prod_|EAAT|mk_live_)[A-Za-z0-9_|-]+/);
});

test("online backup creates a verified, readable SQLite snapshot", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "market-signal-backup-"));
  const sourcePath = path.join(temp, "source.sqlite");
  const backupDir = path.join(temp, "backups");
  const source = new Database(sourcePath);
  source.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  source.prepare("INSERT INTO sample (value) VALUES (?)").run("persisted");
  source.close();

  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts/backup-sqlite.mjs")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MARKET_SIGNAL_SQLITE_PATH: sourcePath,
        MARKET_SIGNAL_BACKUP_DIR: backupDir,
      },
    },
  );
  const result = JSON.parse(output);
  assert.equal(result.integrity, "ok");
  assert.ok(result.bytes > 0);
  assert.equal(path.dirname(result.backup), backupDir);
  assert.deepEqual(
    fs.readdirSync(backupDir).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const verify = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(root, "scripts/verify-sqlite-backup.mjs"), result.backup],
      { encoding: "utf8" },
    ),
  );
  assert.equal(verify.integrity, "ok");

  const restored = new Database(result.backup, { readonly: true });
  assert.equal(restored.prepare("SELECT value FROM sample").pluck().get(), "persisted");
  restored.close();
});
