#!/bin/bash
set -Eeuo pipefail

export LC_ALL=C

env_file="/etc/market-signal/market-signal.env"
config_file="/etc/market-signal/deploy.conf"
consumer="codex-task-feedback-v1"
max_bytes=65536

fail_json() {
  local code="$1"
  printf '{"ok":false,"code":"%s"}\n' "${code}"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail_json "root-required"
[[ -r "${env_file}" && -r "${config_file}" ]] || fail_json "configuration-unavailable"

# Both files are root-owned deployment inputs rather than caller-controlled data.
# shellcheck disable=SC1090
source "${env_file}"
source "${config_file}"

domain="${MARKET_SIGNAL_DOMAIN:-}"
[[ "${domain}" =~ ^[A-Za-z0-9.-]+$ ]] || fail_json "domain-invalid"

action="${1:-}"
method=""
path=""
body=""
token=""

case "${action}" in
  health)
    [[ "$#" -eq 1 ]] || fail_json "arguments-invalid"
    printf '{"ok":true,"service":"evaluation-feedback-monitor","consumer":"%s"}\n' "${consumer}"
    exit 0
    ;;
  claim)
    [[ "$#" -eq 1 ]] || fail_json "arguments-invalid"
    method="POST"
    path="/api/internal/evaluation-feedback/claim"
    body="{\"action\":\"claim\",\"consumer\":\"${consumer}\"}"
    token="${MARKET_SIGNAL_MONITOR_READ_TOKEN:-}"
    ;;
  ack)
    [[ "$#" -eq 5 ]] || fail_json "arguments-invalid"
    delivery_id="$2"
    lease_id="$3"
    payload_hash="$4"
    idempotency_key="$5"
    [[ "${delivery_id}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || fail_json "delivery-id-invalid"
    [[ "${lease_id}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || fail_json "lease-id-invalid"
    [[ "${payload_hash}" =~ ^[a-f0-9]{64}$ ]] || fail_json "payload-hash-invalid"
    [[ "${idempotency_key}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || fail_json "idempotency-key-invalid"
    method="PUT"
    path="/api/internal/evaluation-feedback/ack"
    body="{\"action\":\"acknowledge\",\"consumer\":\"${consumer}\",\"deliveryId\":\"${delivery_id}\",\"leaseId\":\"${lease_id}\",\"payloadHash\":\"${payload_hash}\",\"idempotencyKey\":\"${idempotency_key}\"}"
    token="${MARKET_SIGNAL_MONITOR_ACK_TOKEN:-}"
    ;;
  *) fail_json "action-invalid" ;;
esac

[[ "${token}" =~ ^[A-Za-z0-9_-]{32,}$ ]] || fail_json "credential-unavailable"

temporary="$(mktemp -d /run/market-signal-feedback.XXXXXX)"
trap 'rm -rf -- "${temporary}"' EXIT
chmod 0700 "${temporary}"
curl_config="${temporary}/curl.conf"
response="${temporary}/response.json"
headers="${temporary}/headers"
{
  printf 'silent\nproto = "=https"\ntlsv1.2\nmax-time = 20\nmax-filesize = %s\n' "${max_bytes}"
  printf 'request = "%s"\nurl = "https://%s%s"\n' "${method}" "${domain}" "${path}"
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "${token}"
} >"${curl_config}"
chmod 0600 "${curl_config}"
unset token

status="$(
  (
    ulimit -f 64
    exec env -i PATH=/usr/bin:/bin LC_ALL=C \
      curl --disable --config "${curl_config}" --dump-header "${headers}" --output "${response}" \
        --write-out '%{http_code}' --data-raw "${body}" 2>/dev/null
  )
)" \
  || fail_json "upstream-unavailable"
bytes="$(wc -c <"${response}")"
[[ "${bytes}" -le "${max_bytes}" ]] || fail_json "response-too-large"
header_bytes="$(wc -c <"${headers}")"
[[ "${header_bytes}" -le "${max_bytes}" ]] || fail_json "headers-too-large"
python3 - "${headers}" "${response}" 2>/dev/null <<'PY' || fail_json "response-invalid"
import json
import pathlib
import sys

header_path, body_path = map(pathlib.Path, sys.argv[1:])
raw = header_path.read_bytes()
blocks = [block for block in raw.replace(b"\r\n", b"\n").split(b"\n\n") if block.strip()]
if not blocks:
    raise SystemExit(1)
lines = blocks[-1].decode("latin-1").splitlines()
if not lines or not lines[0].startswith("HTTP/"):
    raise SystemExit(1)
headers = {}
for line in lines[1:]:
    if ":" not in line:
        raise SystemExit(1)
    name, value = line.split(":", 1)
    headers.setdefault(name.strip().lower(), []).append(value.strip().lower())
content_types = headers.get("content-type", [])
cache_controls = headers.get("cache-control", [])
if not any(value == "application/json" or value.startswith("application/json;") for value in content_types):
    raise SystemExit(1)
if not any("no-store" in [part.strip() for part in value.split(",")] for value in cache_controls):
    raise SystemExit(1)
with body_path.open("rb") as body:
    json.load(body)
PY
expected_status="200"
[[ "${action}" == "ack" ]] && expected_status="200 201"
[[ " ${expected_status} " == *" ${status} "* ]] || {
  printf '{"ok":false,"code":"upstream-status","status":%s}\n' "${status}"
  exit 1
}
cat "${response}"
