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

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

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

docker pull "${immutable_ref}"
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

cd "${release_dir}"
export MARKET_SIGNAL_DOMAIN="${domain}"
export MARKET_SIGNAL_ENV_FILE="${env_file}"
export MARKET_SIGNAL_IMAGE_TAG="${short_revision}"
export MARKET_SIGNAL_REVISION="${revision}"

docker compose --env-file "${env_file}" config --quiet
docker compose --env-file "${env_file}" up -d --no-build --pull never

health=""
for _ in $(seq 1 60); do
  health="$(
    docker inspect --format '{{.State.Health.Status}}' "${project_name}-app-1" \
      2>/dev/null || true
  )"
  [[ "${health}" == "healthy" ]] && break
  sleep 2
done
[[ "${health}" == "healthy" ]] || fail "app did not become healthy"

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

ln -sfn "${release_dir}" /opt/market-signal/current
echo "PASS: ${revision} is healthy on ${domain}."
