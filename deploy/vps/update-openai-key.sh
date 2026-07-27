#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

env_file="/etc/market-signal/market-signal.env"
deploy_group="market-deploy"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "OpenAI key update must run as root"
[[ -f "${env_file}" ]] || fail "${env_file} is missing"
[[ ! -L "${env_file}" ]] || fail "${env_file} must not be a symbolic link"

IFS= read -r api_key || fail "OPENAI_API_KEY was not provided on standard input"
[[ "${api_key}" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]] \
  || fail "OPENAI_API_KEY does not have the expected format"
[[ "${api_key}" != *[[:space:]]* ]] || fail "OPENAI_API_KEY contains whitespace"

umask 077
temporary="$(mktemp "${env_file}.XXXXXX")"
cleanup() {
  rm -f -- "${temporary}"
}
trap cleanup EXIT

found=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  if [[ "${line}" == OPENAI_API_KEY=* ]]; then
    printf 'OPENAI_API_KEY=%s\n' "${api_key}" >>"${temporary}"
    found=$((found + 1))
  else
    printf '%s\n' "${line}" >>"${temporary}"
  fi
done <"${env_file}"

[[ "${found}" -eq 1 ]] || fail "expected exactly one OPENAI_API_KEY entry"
chown root:"${deploy_group}" "${temporary}"
chmod 0640 "${temporary}"
mv -f -- "${temporary}" "${env_file}"
trap - EXIT

echo "PASS: OpenAI runtime key updated without changing other configuration."
