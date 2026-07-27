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
  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/BlyzrHQ\/market-signal"/);
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

test("GitHub VPS deployment is manual, pinned, immutable, and non-destructive", () => {
  const workflow = read(".github/workflows/deploy-vps.yml");
  const deploy = read("deploy/vps/deploy-approved-release.sh");
  const updateKey = read("deploy/vps/update-openai-key.sh");
  const installer = read("deploy/vps/install-github-deploy-user.sh");

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):/m);
  assert.match(workflow, /environment:\s*\n\s+name: production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /StrictHostKeyChecking=yes/g);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /git rev-list --first-parent origin\/master/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(workflow, /docker buildx imagetools inspect/);
  assert.match(workflow, /--retry 6 --retry-all-errors --retry-delay 2/);
  assert.match(workflow, /OPENAI_API_KEY:[^\n]*secrets\.OPENAI_API_KEY/);
  assert.doesNotMatch(workflow, /TRIGGER_SECRET_KEY|MARKET_SIGNAL_CALLBACK_TOKEN/);
  assert.doesNotMatch(workflow, /docker (?:image |system )?prune|down -v|ssh-keyscan/);

  assert.match(deploy, /docker pull "\$\{immutable_ref\}"/);
  assert.match(deploy, /backup-sqlite\.mjs/);
  assert.match(deploy, /verify-sqlite-backup\.mjs/);
  assert.match(deploy, /up -d --no-build --pull never/);
  assert.match(deploy, /running container revision/);
  assert.doesNotMatch(deploy, /\brm\s+-rf\b|docker (?:image |system )?prune|down -v/);

  assert.match(updateKey, /IFS= read -r api_key/);
  assert.match(updateKey, /expected exactly one OPENAI_API_KEY entry/);
  assert.match(updateKey, /mv -f -- "\$\{temporary\}" "\$\{env_file\}"/);
  assert.doesNotMatch(updateKey, /echo .*api_key|set -x/);

  assert.match(installer, /market-deploy/);
  assert.match(installer, /ssh-ed25519/);
  assert.match(installer, /visudo -cf/);
  assert.match(installer, /chown -R "\$\{deploy_user\}:\$\{deploy_group\}" \/opt\/market-signal\/releases/);
});

test("repeatable VPS preflight permits only SSH, Caddy, and DHCP listeners", () => {
  const preflight = read("deploy/vps/preflight.sh");
  assert.match(preflight, /port != "22" && port != "80" && port != "443"/);
  assert.match(preflight, /port != "68" && port != "443"/);
  assert.match(preflight, /\/etc\/market-signal\/deploy\.conf/);
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
