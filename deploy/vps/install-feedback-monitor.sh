#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

monitor_user="market-monitor"
monitor_group="market-monitor"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "installer must run as root"
[[ -x "${script_dir}/market-signal-feedback-monitor.sh" ]] || fail "monitor helper is missing or not executable"
[[ -x "${script_dir}/market-signal-feedback-monitor-ssh.sh" ]] || fail "SSH wrapper is missing or not executable"

IFS= read -r public_key || fail "monitor public key was not provided on standard input"
[[ "${public_key}" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] \
  || fail "only an ssh-ed25519 monitor public key is accepted"

if ! getent group "${monitor_group}" >/dev/null; then
  groupadd --system "${monitor_group}"
fi
if ! id "${monitor_user}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --gid "${monitor_group}" "${monitor_user}"
fi
passwd --lock "${monitor_user}" >/dev/null

home_dir="$(getent passwd "${monitor_user}" | cut -d: -f6)"
install -d -o "${monitor_user}" -g "${monitor_group}" -m 0700 "${home_dir}/.ssh"
printf '%s %s\n' \
  'restrict,command="/usr/local/sbin/market-signal-feedback-monitor-ssh"' \
  "${public_key}" >"${home_dir}/.ssh/authorized_keys"
chown "${monitor_user}:${monitor_group}" "${home_dir}/.ssh/authorized_keys"
chmod 0600 "${home_dir}/.ssh/authorized_keys"

install -o root -g root -m 0755 \
  "${script_dir}/market-signal-feedback-monitor.sh" \
  /usr/local/sbin/market-signal-feedback-monitor
install -o root -g root -m 0755 \
  "${script_dir}/market-signal-feedback-monitor-ssh.sh" \
  /usr/local/sbin/market-signal-feedback-monitor-ssh

sudoers_temporary="$(mktemp)"
trap 'rm -f -- "${sudoers_temporary}"' EXIT
printf '%s\n' \
  'market-monitor ALL=(root) NOPASSWD: /usr/local/sbin/market-signal-feedback-monitor *' \
  >"${sudoers_temporary}"
chmod 0440 "${sudoers_temporary}"
visudo -cf "${sudoers_temporary}" >/dev/null
install -o root -g root -m 0440 \
  "${sudoers_temporary}" /etc/sudoers.d/market-signal-feedback-monitor

echo "PASS: restricted evaluation feedback monitor installed."
