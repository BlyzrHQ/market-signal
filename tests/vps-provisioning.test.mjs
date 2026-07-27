import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Ubuntu bootstrap uses the official Docker repository and fails closed", () => {
  const script = read("deploy/vps/bootstrap-ubuntu.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /download\.docker\.com\/linux\/ubuntu\/gpg/);
  assert.match(script, /docker-ce/);
  assert.match(script, /docker-compose-plugin/);
  assert.doesNotMatch(script, /get\.docker\.com/);
  assert.match(script, /Ubuntu 24\.04/);
  assert.match(script, /refusing to bootstrap a host that already has Docker containers/);
  assert.match(script, /APT::Periodic::Unattended-Upgrade "1"/);
});

test("bootstrap preserves SSH and exposes only the intended edge ports", () => {
  const script = read("deploy/vps/bootstrap-ubuntu.sh");
  assert.match(script, /ufw default deny incoming/);
  assert.match(script, /ufw allow OpenSSH/);
  assert.match(script, /ufw allow 80\/tcp/);
  assert.match(script, /ufw allow 443\/tcp/);
  assert.match(script, /ufw allow 443\/udp/);
  assert.doesNotMatch(script, /ufw allow 3000/);
});

test("bootstrap creates the persistent directories with exact ownership", () => {
  const script = read("deploy/vps/bootstrap-ubuntu.sh");
  assert.match(
    script,
    /install -d -o 10001 -g 10001 -m 0750 \/var\/lib\/market-signal/,
  );
  assert.match(
    script,
    /install -d -o 10001 -g 10001 -m 0750 \/var\/backups\/market-signal/,
  );
});

test("preflight verifies DNS, runtime, firewall, resources, and permissions", () => {
  const script = read("deploy/vps/preflight.sh");
  for (const contract of [
    "MARKET_SIGNAL_DOMAIN",
    "MARKET_SIGNAL_EXPECTED_IPV4",
    "docker info",
    "docker compose version",
    "dig +short A",
    "dig +short AAAA",
    "stat -c '%u:%g'",
    "stat -c '%a'",
    "ufw status",
    "ss -H -lntp",
    "ss -H -lnup",
    "MemAvailable",
    "df --output=avail",
  ]) {
    assert.ok(script.includes(contract), `missing preflight contract: ${contract}`);
  }
});

test("shell scripts are pinned to LF in Git checkouts", () => {
  const attributes = read(".gitattributes");
  assert.match(attributes, /^\*\.sh text eol=lf$/m);
});
