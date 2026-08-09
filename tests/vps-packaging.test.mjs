import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  assert.match(compose, /MARKET_SIGNAL_DEPLOY_TARGET:\s*node/);
  assert.match(compose, /MARKET_SIGNAL_EDGE_ENRICH_URL:\s*https:\/\/market-signal\.abdulla617931\.chatgpt\.site\/api\/enrich-products/);
  assert.doesNotMatch(compose, /app:[\s\S]*?ports:\s*\n\s*-\s*["']?\d+:3000/);
  const caddyfile = read("deploy/vps/Caddyfile");
  assert.match(caddyfile, /response_header_timeout 780s/);
  const caddyService = compose.split(/\r?\n  caddy:\r?\n/)[1];
  assert.ok(caddyService);
  assert.doesNotMatch(caddyService, /env_file:/);
  assert.match(caddyService, /MARKET_SIGNAL_DOMAIN:/);
});

test("GitHub VPS deployment is manual, pinned, immutable, and non-destructive", () => {
  const activeWorkflow = path.join(root, ".github/workflows/deploy-vps.yml");
  const workflow = fs.existsSync(activeWorkflow)
    ? fs.readFileSync(activeWorkflow, "utf8")
    : read("deploy/vps/deploy-vps.workflow.yml");
  const deploy = read("deploy/vps/deploy-approved-release.sh");
  const updateKey = read("deploy/vps/update-openai-key.sh");
  const installer = read("deploy/vps/install-github-deploy-user.sh");
  const runnerInstaller = read("deploy/vps/run-ephemeral-github-runner.sh");
  const handoff = read("docs/GITHUB_VPS_HANDOFF.md");
  const originalDecision = read("docs/tasks/078-github-vps-handoff.md");

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):/m);
  assert.match(workflow, /environment:\s*\n\s+name: production/);
  assert.match(
    workflow,
    /runs-on:\s*\n\s+- self-hosted\s*\n\s+- linux\s*\n\s+- x64\s*\n\s+- market-signal-production/,
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /ConnectTimeout=10/g);
  assert.match(workflow, /ServerAliveInterval=15/g);
  assert.match(workflow, /ServerAliveCountMax=3/g);
  assert.match(workflow, /StrictHostKeyChecking=yes/g);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /git rev-list --first-parent origin\/master/);
  assert.match(workflow, /git cat-file -e "\$\{REQUESTED_SHA\}\^\{commit\}"/);
  assert.match(workflow, /git checkout --detach "\$\{REQUESTED_SHA\}"/);
  assert.doesNotMatch(workflow, /git fetch --no-tags origin master/);
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
  assert.match(deploy, /restore_previous_release/);
  assert.match(deploy, /ROLLBACK: restoring/);
  assert.match(deploy, /candidate Compose startup failed/);
  assert.match(deploy, /candidate app did not become healthy/);
  assert.match(deploy, /candidate internal capability probe failed/);
  assert.match(deploy, /candidate SQLite read probe failed/);
  assert.match(deploy, /timeout 10m docker pull/);
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

  assert.match(runnerInstaller, /runner_version="2\.336\.0"/);
  assert.match(
    runnerInstaller,
    /runner_sha256="04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d"/,
  );
  assert.match(runnerInstaller, /sha256sum --check --status/);
  assert.match(runnerInstaller, /runner_user="github-runner"/);
  assert.match(runnerInstaller, /run\.sh --jitconfig/);
  assert.match(
    runnerInstaller,
    /cleanup_helper="\/usr\/local\/sbin\/market-signal-cleanup-ephemeral-runner"/,
  );
  assert.match(
    runnerInstaller,
    /ExecStopPost=\+\/usr\/bin\/systemd-run --quiet --collect --wait --unit=\$\{cleanup_unit_name\} \$\{cleanup_helper\}/,
  );
  assert.match(
    runnerInstaller,
    /cleanup_unit_name="market-signal-ephemeral-runner-cleanup\.service"/,
  );
  assert.match(runnerInstaller, /\[\[ -x \/usr\/bin\/systemd-run \]\]/);
  assert.doesNotMatch(runnerInstaller, /^ExecStopPost=\+\$\{cleanup_helper\}$/m);
  assert.match(runnerInstaller, /RuntimeMaxSec=80min/);
  assert.match(runnerInstaller, /KillMode=control-group/);
  assert.match(runnerInstaller, /flock --nonblock 9/);
  assert.match(runnerInstaller, /created_runner_dir="false"/);
  assert.match(runnerInstaller, /created_runtime_dir="false"/);
  assert.match(runnerInstaller, /created_user="false"/);
  assert.match(runnerInstaller, /created_unit="false"/);
  assert.match(runnerInstaller, /created_cleanup_helper="false"/);
  assert.match(runnerInstaller, /trap cleanup_partial_install EXIT/);
  assert.match(runnerInstaller, /trap on_signal HUP INT TERM/);
  assert.match(runnerInstaller, /trap '' HUP INT TERM/);
  assert.match(runnerInstaller, /timeout 30s systemctl start/);
  assert.match(runnerInstaller, /runner_home="\/run\/market-signal-runner\/home"/);
  assert.match(
    runnerInstaller,
    /install -d -o root -g "\$\{runner_user\}" -m 0710 "\/run\/market-signal-runner"/,
  );
  assert.match(runnerInstaller, /ProtectSystem=strict/);
  assert.match(runnerInstaller, /NoNewPrivileges=yes/);
  assert.match(runnerInstaller, /rm -rf -- '\$\{runner_dir\}'/);
  assert.doesNotMatch(runnerInstaller, /RUNNER_ALLOW_RUNASROOT/);
  assert.doesNotMatch(runnerInstaller, /svc\.sh/);
  assert.match(installer, /from="127\.0\.0\.1,::1"/);
  assert.match(installer, /no-port-forwarding/);

  assert.match(handoff, /`VPS_HOST=127\.0\.0\.1`/);
  assert.match(
    handoff,
    /`VPS_HOST_KEY=127\.0\.0\.1 ssh-ed25519 <trusted host key>`/,
  );
  assert.match(handoff, /actions\/runners\/generate-jitconfig/);
  assert.match(handoff, /labels\[\]=market-signal-production/);
  assert.match(handoff, /Do not launch the runner before the build passes/);
  assert.match(originalDecision, /rejection of a self-hosted runner is superseded/);
});

test("repeatable VPS preflight permits only SSH, Caddy, and DHCP listeners", () => {
  const preflight = read("deploy/vps/preflight.sh");
  assert.match(preflight, /port != "22" && port != "80" && port != "443"/);
  assert.match(preflight, /port != "68" && port != "443"/);
  assert.match(preflight, /\/etc\/market-signal\/deploy\.conf/);
});

test("evaluation feedback monitor is forced, bounded, and credential-isolated", () => {
  const helper = read("deploy/vps/market-signal-feedback-monitor.sh");
  const wrapper = read("deploy/vps/market-signal-feedback-monitor-ssh.sh");
  const loginShell = read("deploy/vps/market-signal-feedback-monitor-login-shell.sh");
  const installer = read("deploy/vps/install-feedback-monitor.sh");
  const automation = read("deploy/vps/evaluation-feedback-automation-prompt.md");

  assert.match(helper, /max_bytes=65536/);
  assert.match(helper, /max-time = 20/);
  assert.match(helper, /max-filesize/);
  assert.match(helper, /MARKET_SIGNAL_MONITOR_READ_TOKEN/);
  assert.match(helper, /MARKET_SIGNAL_MONITOR_ACK_TOKEN/);
  assert.match(helper, /curl --disable --config/);
  assert.match(helper, /env -i PATH=\/usr\/bin:\/bin LC_ALL=C/);
  assert.match(helper, /ulimit -f 64/);
  assert.match(helper, /json\.load\(body\)/);
  assert.match(helper, /expected_status="200 201"/);
  assert.match(helper, /chmod 0600 "\$\{curl_config\}"/);
  assert.doesNotMatch(helper, /Authorization: Bearer[^\n]*curl /);
  assert.doesNotMatch(helper, /MARKET_SIGNAL_OWNER_(?:READ|WRITE)_TOKEN/);
  assert.match(helper, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(helper, /cache-control/);
  assert.match(helper, /no-store/);

  assert.match(wrapper, /SSH_ORIGINAL_COMMAND/);
  assert.match(wrapper, /exec sudo \/usr\/local\/sbin\/market-signal-feedback-monitor/);
  assert.doesNotMatch(wrapper, /eval|bash -c|sh -c/);
  assert.match(loginShell, /#!\/bin\/dash/);
  assert.match(loginShell, /\/usr\/bin\/env -i LC_ALL=C PATH=\/usr\/bin:\/bin SSH_ORIGINAL_COMMAND=/);
  assert.match(loginShell, /\[ "\$2" = "\/usr\/local\/sbin\/market-signal-feedback-monitor-ssh" \]/);
  assert.doesNotMatch(loginShell, /eval|bash -c|sh -c/);
  assert.match(installer, /restrict,command=/);
  assert.match(installer, /passwd --lock/);
  assert.match(installer, /trap rollback EXIT/);
  assert.match(installer, /rollback_armed=1/);
  assert.match(installer, /visudo -cf "\$\{transaction\}\/sudoers"/);
  assert.match(installer, /--shell "\$\{monitor_shell\}"/);
  assert.match(installer, /root:root:755/);
  assert.doesNotMatch(installer, /usermod .*docker/);
  assert.match(automation, /at most three times\s+sequentially/);
  assert.match(automation, /Only after that complete presentation succeeds/);
  assert.match(automation, /Never acknowledge a failed or incomplete\s+presentation/);
  assert.match(automation, /exact open human-review question and stable request ID/);
  assert.match(automation, /100,000\s+micro-USD/);
  assert.match(automation, /non-null integer `costMicrousd` is known cost/);
  assert.match(automation, /completedAt.*UTC calendar/);

  const lastBackup = installer.lastIndexOf("backup_target ");
  const rollbackArm = installer.indexOf("rollback_armed=1");
  const firstPrivilegedMutation = installer.indexOf("groupadd --system", rollbackArm);
  assert.ok(lastBackup > 0 && rollbackArm > lastBackup);
  assert.ok(firstPrivilegedMutation > rollbackArm);

  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
  for (const originalCommand of ["claim\nunexpected", "claim\runexpected", "claim\tunexpected", "claim "]) {
    const rejected = spawnSync(bash, ["deploy/vps/market-signal-feedback-monitor-ssh.sh"], {
      cwd: root,
      env: { ...process.env, SSH_ORIGINAL_COMMAND: originalCommand },
      encoding: "utf8",
    });
    assert.equal(rejected.status, 64, JSON.stringify({ originalCommand, stderr: rejected.stderr }));
  }
});

test("runtime dependencies required by vinext are installed in production", () => {
  const manifest = JSON.parse(read("package.json"));
  const dockerfile = read("Dockerfile");
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
  assert.match(dockerfile, /npm ci --omit=dev --omit=peer/);
  assert.match(dockerfile, /npm uninstall --no-save --omit=dev --omit=peer drizzle-kit/);
  assert.match(dockerfile, /test ! -d node_modules\/drizzle-kit/);
  assert.match(dockerfile, /await import\('vite'\)/);
  assert.equal(manifest.devDependencies["drizzle-kit"], "0.31.10");
  assert.equal(manifest.dependencies["drizzle-kit"], undefined);
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
