#!/usr/bin/env bash
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
set -a
source "${env_file}"
source "${config_file}"
set +a

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
  printf 'silent\nshow-error\nproto = "=https"\ntlsv1.2\nmax-time = 20\nmax-filesize = %s\n' "${max_bytes}"
  printf 'request = "%s"\nurl = "https://%s%s"\n' "${method}" "${domain}" "${path}"
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "${token}"
} >"${curl_config}"
chmod 0600 "${curl_config}"
unset token

status="$(curl --config "${curl_config}" --dump-header "${headers}" --output "${response}" --write-out '%{http_code}' --data-raw "${body}")" \
  || fail_json "upstream-unavailable"
bytes="$(wc -c <"${response}")"
[[ "${bytes}" -le "${max_bytes}" ]] || fail_json "response-too-large"
grep -qi '^content-type:.*application/json' "${headers}" || fail_json "response-not-json"
grep -qi '^cache-control:.*no-store' "${headers}" || fail_json "response-cacheable"
[[ "${status}" == "200" ]] || {
  printf '{"ok":false,"code":"upstream-status","status":%s}\n' "${status}"
  exit 1
}
cat "${response}"
