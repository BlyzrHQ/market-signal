#!/bin/bash
set -Eeuo pipefail

export LC_ALL=C

monitor_user="market-monitor"
monitor_group="market-monitor"
monitor_home="/var/lib/market-signal-monitor"
monitor_shell="/usr/local/sbin/market-signal-feedback-monitor-login-shell"
helper="/usr/local/sbin/market-signal-feedback-monitor"
wrapper="/usr/local/sbin/market-signal-feedback-monitor-ssh"
sudoers="/etc/sudoers.d/market-signal-feedback-monitor"
authorized_keys="${monitor_home}/.ssh/authorized_keys"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
transaction="$(mktemp -d /run/market-signal-monitor-install.XXXXXX)"
created_user=0
created_group=0
created_home=0
committed=0
rollback_armed=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

backup_target() {
  local target="$1"
  local name="$2"
  if [[ -e "${target}" || -L "${target}" ]]; then
    cp -a -- "${target}" "${transaction}/backup-${name}"
    : >"${transaction}/had-${name}"
  fi
}

restore_target() {
  local target="$1"
  local name="$2"
  rm -f -- "${target}"
  if [[ -e "${transaction}/had-${name}" ]]; then
    cp -a -- "${transaction}/backup-${name}" "${target}"
  fi
}

rollback() {
  local status="$?"
  if [[ "${committed}" -eq 0 && "${rollback_armed}" -eq 1 ]]; then
    rm -f -- "${sudoers}.new" "${wrapper}.new" "${helper}.new" "${monitor_shell}.new" "${authorized_keys}.new"
    restore_target "${sudoers}" sudoers
    restore_target "${wrapper}" wrapper
    restore_target "${helper}" helper
    restore_target "${monitor_shell}" shell
    if [[ -d "${monitor_home}/.ssh" ]]; then
      restore_target "${authorized_keys}" authorized-keys
    fi
    if [[ "${created_user}" -eq 1 ]]; then
      userdel "${monitor_user}" >/dev/null 2>&1 || true
    fi
    if [[ "${created_home}" -eq 1 ]]; then
      rm -rf -- "${monitor_home}"
    fi
    if [[ "${created_group}" -eq 1 ]]; then
      groupdel "${monitor_group}" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf -- "${transaction}"
  exit "${status}"
}
trap rollback EXIT

[[ "${EUID}" -eq 0 ]] || fail "installer must run as root"
required_commands=(awk bash chmod cp cut dirname getent grep groupadd groupdel id install mktemp mv passwd python3 rm stat tr useradd userdel visudo)
for command_name in "${required_commands[@]}"; do
  command -v "${command_name}" >/dev/null || fail "required command is unavailable: ${command_name}"
done
source_names=(market-signal-feedback-monitor.sh market-signal-feedback-monitor-ssh.sh market-signal-feedback-monitor-login-shell.sh)
for source_name in "${source_names[@]}"; do
  [[ -f "${script_dir}/${source_name}" ]] || fail "required source is missing: ${source_name}"
  bash -n "${script_dir}/${source_name}" || fail "invalid shell source: ${source_name}"
done

IFS= read -r public_key || fail "monitor public key was not provided on standard input"
[[ "${public_key}" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || fail "only an ssh-ed25519 monitor public key is accepted"

install -o root -g root -m 0755 "${script_dir}/market-signal-feedback-monitor.sh" "${transaction}/helper"
install -o root -g root -m 0755 "${script_dir}/market-signal-feedback-monitor-ssh.sh" "${transaction}/wrapper"
install -o root -g root -m 0755 "${script_dir}/market-signal-feedback-monitor-login-shell.sh" "${transaction}/shell"
printf '%s\n' 'market-monitor ALL=(root) NOPASSWD: /usr/local/sbin/market-signal-feedback-monitor *' >"${transaction}/sudoers"
chmod 0440 "${transaction}/sudoers"
visudo -cf "${transaction}/sudoers" >/dev/null
printf '%s %s\n' 'restrict,command="/usr/local/sbin/market-signal-feedback-monitor-ssh"' "${public_key}" >"${transaction}/authorized_keys"
chmod 0600 "${transaction}/authorized_keys"

if id "${monitor_user}" >/dev/null 2>&1; then
  passwd_entry="$(getent passwd "${monitor_user}")"
  [[ "$(cut -d: -f6 <<<"${passwd_entry}")" == "${monitor_home}" ]] || fail "existing monitor account has an unexpected home"
  [[ "$(cut -d: -f7 <<<"${passwd_entry}")" == "${monitor_shell}" ]] || fail "existing monitor account has an unexpected shell"
  [[ "$(id -gn "${monitor_user}")" == "${monitor_group}" ]] || fail "existing monitor account has an unexpected primary group"
  ! id -nG "${monitor_user}" | tr ' ' '\n' | grep -Fxq docker || fail "monitor account must not belong to the docker group"
  [[ -d "${monitor_home}/.ssh" ]] || fail "existing monitor SSH directory is missing"
  [[ "$(stat -c '%U:%G:%a' "${monitor_home}")" == "root:root:755" ]] || fail "existing monitor home must be root-owned and mode 0755"
  [[ "$(stat -c '%U:%G:%a' "${monitor_home}/.ssh")" == "root:${monitor_group}:750" ]] || fail "existing monitor SSH directory must be root-owned, monitor-readable, and mode 0750"
  [[ -f "${authorized_keys}" ]] || fail "existing monitor authorized_keys is missing"
  [[ "$(stat -c '%U:%G:%a' "${authorized_keys}")" == "root:${monitor_group}:640" ]] || fail "existing monitor authorized_keys must be root-owned, monitor-readable, and mode 0640"
  [[ "$(passwd -S "${monitor_user}" | awk '{print $2}')" == "L" ]] || fail "existing monitor account must remain password-locked"
else
  [[ ! -e "${monitor_home}" ]] || fail "monitor home exists without its dedicated account"
fi

backup_target "${monitor_shell}" shell
backup_target "${helper}" helper
backup_target "${wrapper}" wrapper
backup_target "${sudoers}" sudoers
backup_target "${authorized_keys}" authorized-keys
rollback_armed=1

if ! getent group "${monitor_group}" >/dev/null; then
  groupadd --system "${monitor_group}"
  created_group=1
fi

install -o root -g root -m 0755 "${transaction}/shell" "${monitor_shell}.new"
mv -f -- "${monitor_shell}.new" "${monitor_shell}"
install -o root -g root -m 0755 "${transaction}/helper" "${helper}.new"
mv -f -- "${helper}.new" "${helper}"
install -o root -g root -m 0755 "${transaction}/wrapper" "${wrapper}.new"
mv -f -- "${wrapper}.new" "${wrapper}"

if ! id "${monitor_user}" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "${monitor_home}" --shell "${monitor_shell}" --gid "${monitor_group}" "${monitor_user}"
  created_user=1
  install -d -o root -g root -m 0755 "${monitor_home}"
  created_home=1
  install -d -o root -g "${monitor_group}" -m 0750 "${monitor_home}/.ssh"
  passwd --lock "${monitor_user}" >/dev/null
fi

install -o root -g "${monitor_group}" -m 0640 "${transaction}/authorized_keys" "${authorized_keys}.new"
mv -f -- "${authorized_keys}.new" "${authorized_keys}"
install -o root -g root -m 0440 "${transaction}/sudoers" "${sudoers}.new"
visudo -cf "${sudoers}.new" >/dev/null
mv -f -- "${sudoers}.new" "${sudoers}"

committed=1
echo "PASS: restricted evaluation feedback monitor installed."
