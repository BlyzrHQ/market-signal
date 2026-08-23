#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

revision="${1:-}"
expected_digest="${2:-}"
registry_image="${3:-}"
release_dir="${4:-}"
domain="${5:-}"
env_file="/etc/market-signal/market-signal.env"
project_name="market-signal"
switched="false"
previous_release=""
previous_revision=""
previous_image_tag=""

wait_for_service_health() {
  local service="$1"
  local health=""
  for _ in $(seq 1 60); do
    health="$(
      docker inspect --format '{{.State.Health.Status}}' "${project_name}-${service}-1" \
        2>/dev/null || true
    )"
    [[ "${health}" == "healthy" ]] && return 0
    sleep 2
  done
  return 1
}

wait_for_health() {
  wait_for_service_health app || return 1
  if docker compose --env-file "${env_file}" config --services | grep -qx worker; then
    wait_for_service_health worker || return 1
  fi
}

restore_previous_release() {
  [[ -n "${previous_release}" && -d "${previous_release}" ]] || return 1
  [[ "${previous_revision}" =~ ^[0-9a-f]{40}$ ]] || return 1

  echo "ROLLBACK: restoring ${previous_revision}." >&2
  cd "${previous_release}"
  export MARKET_SIGNAL_DOMAIN="${domain}"
  export MARKET_SIGNAL_ENV_FILE="${env_file}"
  export MARKET_SIGNAL_IMAGE_TAG="${previous_image_tag}"
  export MARKET_SIGNAL_REVISION="${previous_revision}"
  timeout 3m docker compose --env-file "${env_file}" config --quiet
  timeout 5m docker compose --env-file "${env_file}" \
    up -d --no-build --pull never --remove-orphans
  wait_for_health
  restored_revision="$(
    docker inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "${project_name}-app-1"
  )"
  [[ "${restored_revision}" == "${previous_revision}" ]]
  ln -sfn "${previous_release}" /opt/market-signal/current
  echo "ROLLBACK: ${previous_revision} is healthy." >&2
}

fail() {
  local message="$*"
  echo "FAIL: ${message}" >&2
  if [[ "${switched}" == "true" ]]; then
    switched="false"
    restore_previous_release ||
      echo "FAIL: automatic rollback did not restore a healthy release." >&2
  fi
  exit 1
}

on_error() {
  local status=$?
  if [[ "${switched}" == "true" ]]; then
    switched="false"
    restore_previous_release ||
      echo "FAIL: automatic rollback did not restore a healthy release." >&2
  fi
  exit "${status}"
}

trap on_error ERR

[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || fail "revision must be a full lowercase SHA"
[[ "${expected_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "image digest is invalid"
[[ "${registry_image}" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]] || fail "registry image is invalid"
[[ "${release_dir}" == "/opt/market-signal/releases/${revision}" ]] \
  || fail "release directory does not match revision"
[[ "${domain}" =~ ^[A-Za-z0-9.-]+$ ]] || fail "domain is invalid"
[[ -d "${release_dir}" ]] || fail "release directory is missing"
[[ -f "${release_dir}/compose.yaml" ]] || fail "compose.yaml is missing"
[[ -f "${release_dir}/deploy/vps/Caddyfile" ]] || fail "Caddyfile is missing"
[[ -f "${env_file}" ]] || fail "${env_file} is missing"
[[ ! -L "${env_file}" ]] || fail "${env_file} must not be a symbolic link"

short_revision="${revision:0:12}"
immutable_ref="${registry_image}@${expected_digest}"
local_ref="market-signal:${short_revision}"

timeout 10m docker pull "${immutable_ref}"
actual_digest="$(
  docker image inspect "${immutable_ref}" \
    --format '{{join .RepoDigests "\n"}}' |
    sed -n 's/^.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' |
    sort -u
)"
[[ "${actual_digest}" == "${expected_digest}" ]] \
  || fail "pulled image digest does not match the approved digest"
actual_revision="$(
  docker image inspect "${immutable_ref}" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
)"
[[ "${actual_revision}" == "${revision}" ]] \
  || fail "pulled image revision label does not match the approved revision"
docker tag "${immutable_ref}" "${local_ref}"

if [[ -s /var/lib/market-signal/market-signal.sqlite ]]; then
  running="$(
    docker inspect --format '{{.State.Running}}' "${project_name}-app-1" 2>/dev/null ||
      true
  )"
  [[ "${running}" == "true" ]] \
    || fail "SQLite exists but the current app is not running for an online backup"
  backup_result="$(
    docker exec "${project_name}-app-1" node scripts/backup-sqlite.mjs
  )"
  backup_path="$(
    sed -n 's/^.*"backup":"\([^"]*\)".*$/\1/p' <<<"${backup_result}"
  )"
  [[ "${backup_path}" == /backups/market-signal-*.sqlite ]] \
    || fail "backup script did not return a valid backup path"
  docker exec "${project_name}-app-1" \
    node scripts/verify-sqlite-backup.mjs "${backup_path}" >/dev/null
  echo "PASS: pre-deploy SQLite backup verified."
fi

previous_release="$(readlink -f /opt/market-signal/current 2>/dev/null || true)"
if [[ -n "${previous_release}" && -d "${previous_release}" ]]; then
  previous_revision="$(
    docker inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "${project_name}-app-1" 2>/dev/null || true
  )"
  if [[ "${previous_revision}" =~ ^[0-9a-f]{40}$ ]]; then
    previous_image_tag="${previous_revision:0:12}"
  else
    previous_release=""
    previous_revision=""
  fi
fi

cd "${release_dir}"
export MARKET_SIGNAL_DOMAIN="${domain}"
export MARKET_SIGNAL_ENV_FILE="${env_file}"
export MARKET_SIGNAL_IMAGE_TAG="${short_revision}"
export MARKET_SIGNAL_REVISION="${revision}"

timeout 3m docker compose --env-file "${env_file}" config --quiet
switched="true"
timeout 5m docker compose --env-file "${env_file}" \
  up -d --no-build --pull never --remove-orphans ||
  fail "candidate Compose startup failed"
wait_for_service_health app || fail "candidate app did not become healthy"
wait_for_service_health worker || fail "candidate worker did not become healthy"

running_revision="$(
  docker inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "${project_name}-app-1"
)"
[[ "${running_revision}" == "${revision}" ]] \
  || fail "running container revision does not match the approved revision"
running_image_id="$(
  docker inspect --format '{{.Image}}' "${project_name}-app-1"
)"
expected_image_id="$(docker image inspect --format '{{.Id}}' "${local_ref}")"
[[ "${running_image_id}" == "${expected_image_id}" ]] \
  || fail "running container image does not match the approved image"

worker_revision="$(
  docker inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "${project_name}-worker-1"
)"
[[ "${worker_revision}" == "${revision}" ]] \
  || fail "running worker revision does not match the approved revision"
worker_image_id="$(docker inspect --format '{{.Image}}' "${project_name}-worker-1")"
[[ "${worker_image_id}" == "${expected_image_id}" ]] \
  || fail "running worker image does not match the approved image"

docker exec "${project_name}-app-1" node -e '
  const token = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  if (!token) process.exit(1);
  fetch("http://127.0.0.1:3000/api/internal/capabilities", {
    headers: { authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) process.exit(1);
    const body = await response.json();
    if (!body || typeof body !== "object") process.exit(1);
  }).catch(() => process.exit(1));
' || fail "candidate internal capability probe failed"

docker exec "${project_name}-worker-1" node -e '
  const token = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  if (!token) process.exit(1);
  fetch("http://127.0.0.1:3000/api/internal/capabilities", {
    headers: { authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) process.exit(1);
    const body = await response.json();
    if (!body || typeof body !== "object") process.exit(1);
  }).catch(() => process.exit(1));
' || fail "candidate worker internal capability probe failed"

docker exec "${project_name}-app-1" node -e '
  const Database = require("better-sqlite3");
  const database = new Database(process.env.MARKET_SIGNAL_SQLITE_PATH, {
    readonly: true,
  });
  const value = database.prepare("SELECT 1 AS ok").pluck().get();
  database.close();
  if (value !== 1) process.exit(1);
' || fail "candidate SQLite read probe failed"

docker exec "${project_name}-worker-1" node -e '
  const Database = require("better-sqlite3");
  const database = new Database(process.env.MARKET_SIGNAL_SQLITE_PATH, {
    readonly: true,
  });
  const value = database.prepare("SELECT 1 AS ok").pluck().get();
  database.close();
  if (value !== 1) process.exit(1);
' || fail "candidate worker SQLite read probe failed"

ln -sfn "${release_dir}" /opt/market-signal/current
switched="false"
echo "PASS: ${revision} is healthy on ${domain}."
