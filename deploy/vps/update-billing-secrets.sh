#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

env_file="/etc/market-signal/market-signal.env"
deploy_group="market-deploy"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "billing secret update must run as root"
[[ -f "${env_file}" ]] || fail "${env_file} is missing"
[[ ! -L "${env_file}" ]] || fail "${env_file} must not be a symbolic link"

IFS= read -r restricted_key || fail "STRIPE_RESTRICTED_KEY was not provided"
IFS= read -r webhook_secret || fail "STRIPE_WEBHOOK_SECRET was not provided"
[[ "${restricted_key}" =~ ^rk_(test|live)_[A-Za-z0-9_]{20,}$ ]] \
  || fail "STRIPE_RESTRICTED_KEY does not have the expected format"
[[ "${webhook_secret}" =~ ^whsec_[A-Za-z0-9]{20,}$ ]] \
  || fail "STRIPE_WEBHOOK_SECRET does not have the expected format"
[[ "${restricted_key}" != *[[:space:]]* ]] || fail "STRIPE_RESTRICTED_KEY contains whitespace"
[[ "${webhook_secret}" != *[[:space:]]* ]] || fail "STRIPE_WEBHOOK_SECRET contains whitespace"

umask 077
temporary="$(mktemp "${env_file}.XXXXXX")"
cleanup() {
  rm -f -- "${temporary}"
}
trap cleanup EXIT

restricted_found=0
webhook_found=0
hosted_found=0
price_starter_found=0
price_solo_found=0
price_growth_found=0
price_agency_found=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  case "${line}" in
    STRIPE_RESTRICTED_KEY=*)
      printf 'STRIPE_RESTRICTED_KEY=%s\n' "${restricted_key}" >>"${temporary}"
      restricted_found=$((restricted_found + 1))
      ;;
    STRIPE_WEBHOOK_SECRET=*)
      printf 'STRIPE_WEBHOOK_SECRET=%s\n' "${webhook_secret}" >>"${temporary}"
      webhook_found=$((webhook_found + 1))
      ;;
    MARKET_SIGNAL_HOSTED_BILLING=*)
      printf 'MARKET_SIGNAL_HOSTED_BILLING=true\n' >>"${temporary}"
      hosted_found=$((hosted_found + 1))
      ;;
    STRIPE_PRICE_STARTER=*)
      [[ "${line#*=}" =~ ^price_[A-Za-z0-9_]{8,}$ ]] \
        || fail "STRIPE_PRICE_STARTER is missing or invalid"
      printf '%s\n' "${line}" >>"${temporary}"
      price_starter_found=$((price_starter_found + 1))
      ;;
    STRIPE_PRICE_SOLO=*)
      [[ "${line#*=}" =~ ^price_[A-Za-z0-9_]{8,}$ ]] \
        || fail "STRIPE_PRICE_SOLO is missing or invalid"
      printf '%s\n' "${line}" >>"${temporary}"
      price_solo_found=$((price_solo_found + 1))
      ;;
    STRIPE_PRICE_GROWTH=*)
      [[ "${line#*=}" =~ ^price_[A-Za-z0-9_]{8,}$ ]] \
        || fail "STRIPE_PRICE_GROWTH is missing or invalid"
      printf '%s\n' "${line}" >>"${temporary}"
      price_growth_found=$((price_growth_found + 1))
      ;;
    STRIPE_PRICE_AGENCY=*)
      [[ "${line#*=}" =~ ^price_[A-Za-z0-9_]{8,}$ ]] \
        || fail "STRIPE_PRICE_AGENCY is missing or invalid"
      printf '%s\n' "${line}" >>"${temporary}"
      price_agency_found=$((price_agency_found + 1))
      ;;
    *)
      printf '%s\n' "${line}" >>"${temporary}"
      ;;
  esac
done <"${env_file}"

[[ "${restricted_found}" -eq 1 ]] || fail "expected exactly one STRIPE_RESTRICTED_KEY entry"
[[ "${webhook_found}" -eq 1 ]] || fail "expected exactly one STRIPE_WEBHOOK_SECRET entry"
[[ "${hosted_found}" -eq 1 ]] || fail "expected exactly one MARKET_SIGNAL_HOSTED_BILLING entry"
[[ "${price_starter_found}" -eq 1 ]] || fail "expected exactly one STRIPE_PRICE_STARTER entry"
[[ "${price_solo_found}" -eq 1 ]] || fail "expected exactly one STRIPE_PRICE_SOLO entry"
[[ "${price_growth_found}" -eq 1 ]] || fail "expected exactly one STRIPE_PRICE_GROWTH entry"
[[ "${price_agency_found}" -eq 1 ]] || fail "expected exactly one STRIPE_PRICE_AGENCY entry"
chown root:"${deploy_group}" "${temporary}"
chmod 0640 "${temporary}"
mv -f -- "${temporary}" "${env_file}"
trap - EXIT

echo "PASS: Stripe runtime secrets updated and hosted billing enabled."
