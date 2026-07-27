#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

deploy_user="market-deploy"
deploy_group="market-deploy"
runtime_dir="/etc/market-signal"
runtime_env="${runtime_dir}/market-signal.env"
legacy_env="/opt/market-signal/current/deploy/vps/market-signal.env"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
domain="${MARKET_SIGNAL_DOMAIN:-}"
expected_ipv4="${MARKET_SIGNAL_EXPECTED_IPV4:-}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "installer must run as root"
[[ "${domain}" =~ ^[A-Za-z0-9.-]+$ ]] || fail "MARKET_SIGNAL_DOMAIN is invalid"
[[ "${expected_ipv4}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] \
  || fail "MARKET_SIGNAL_EXPECTED_IPV4 is invalid"
[[ -x "${script_dir}/preflight.sh" ]] || fail "preflight.sh is missing or not executable"
[[ -x "${script_dir}/update-openai-key.sh" ]] \
  || fail "update-openai-key.sh is missing or not executable"

IFS= read -r public_key || fail "deploy public key was not provided on standard input"
[[ "${public_key}" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] \
  || fail "only an ssh-ed25519 deploy public key is accepted"

if ! getent group "${deploy_group}" >/dev/null; then
  groupadd --system "${deploy_group}"
fi
if ! id "${deploy_user}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --gid "${deploy_group}" "${deploy_user}"
fi
usermod -aG docker "${deploy_user}"

home_dir="$(getent passwd "${deploy_user}" | cut -d: -f6)"
install -d -o "${deploy_user}" -g "${deploy_group}" -m 0700 "${home_dir}/.ssh"
printf '%s %s\n' \
  'from="127.0.0.1,::1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty' \
  "${public_key}" >"${home_dir}/.ssh/authorized_keys"
chown "${deploy_user}:${deploy_group}" "${home_dir}/.ssh/authorized_keys"
chmod 0600 "${home_dir}/.ssh/authorized_keys"

install -d -o root -g "${deploy_group}" -m 0750 "${runtime_dir}"
if [[ ! -f "${runtime_env}" ]]; then
  [[ -f "${legacy_env}" ]] || fail "neither ${runtime_env} nor ${legacy_env} exists"
  install -o root -g "${deploy_group}" -m 0640 "${legacy_env}" "${runtime_env}"
fi
chown root:"${deploy_group}" "${runtime_env}"
chmod 0640 "${runtime_env}"

install -o root -g root -m 0755 \
  "${script_dir}/preflight.sh" /usr/local/sbin/market-signal-preflight
install -o root -g root -m 0755 \
  "${script_dir}/update-openai-key.sh" /usr/local/sbin/market-signal-update-openai-key

cat >/etc/market-signal/deploy.conf <<EOF
MARKET_SIGNAL_DOMAIN=${domain}
MARKET_SIGNAL_EXPECTED_IPV4=${expected_ipv4}
EOF
chown root:root /etc/market-signal/deploy.conf
chmod 0644 /etc/market-signal/deploy.conf

sudoers_temporary="$(mktemp)"
cat >"${sudoers_temporary}" <<'EOF'
market-deploy ALL=(root) NOPASSWD: /usr/local/sbin/market-signal-preflight
market-deploy ALL=(root) NOPASSWD: /usr/local/sbin/market-signal-update-openai-key
EOF
chmod 0440 "${sudoers_temporary}"
visudo -cf "${sudoers_temporary}" >/dev/null
install -o root -g root -m 0440 \
  "${sudoers_temporary}" /etc/sudoers.d/market-signal-deploy
rm -f -- "${sudoers_temporary}"

install -d -o "${deploy_user}" -g "${deploy_group}" -m 0750 \
  /opt/market-signal /opt/market-signal/releases
chown "${deploy_user}:${deploy_group}" /opt/market-signal
chown -R "${deploy_user}:${deploy_group}" /opt/market-signal/releases
find /opt/market-signal/releases -type f -name market-signal.env \
  -exec chown root:"${deploy_group}" {} + \
  -exec chmod 0640 {} +

echo "PASS: dedicated GitHub Actions deploy account installed."
