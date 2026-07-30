#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

runner_version="2.336.0"
runner_sha256="04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d"
runner_user="github-runner"
runner_home="/run/market-signal-runner/home"
runner_dir="/opt/actions-runner-${runner_version}"
runtime_dir="/run/market-signal-runner/state"
unit_name="market-signal-ephemeral-runner.service"
cleanup_unit_name="market-signal-ephemeral-runner-cleanup.service"
cleanup_helper="/usr/local/sbin/market-signal-cleanup-ephemeral-runner"
systemd_owns_cleanup="false"
archive=""
created_user="false"
created_runner_dir="false"
created_runtime_dir="false"
created_unit="false"
created_cleanup_helper="false"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup_partial_install() {
  [[ -z "${archive}" ]] || rm -f -- "${archive}"
  if [[ "${systemd_owns_cleanup}" != "true" ]]; then
    [[ "${created_runner_dir}" != "true" ]] || rm -rf -- "${runner_dir}"
    [[ "${created_runtime_dir}" != "true" ]] ||
      rm -rf -- "/run/market-signal-runner"
    if [[ "${created_user}" == "true" ]]; then
      userdel "${runner_user}" >/dev/null 2>&1 || true
      getent group "${runner_user}" >/dev/null 2>&1 &&
        groupdel "${runner_user}" >/dev/null 2>&1 || true
    fi
    [[ "${created_unit}" != "true" ]] ||
      rm -f -- "/etc/systemd/system/${unit_name}"
    [[ "${created_cleanup_helper}" != "true" ]] ||
      rm -f -- "${cleanup_helper}"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
}

on_signal() {
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "launcher must run as root"
exec 9>/run/lock/market-signal-ephemeral-runner.lock
flock --nonblock 9 || fail "another ephemeral runner launch is active"
[[ ! -e "${runner_dir}" ]] || fail "${runner_dir} must not already exist"
[[ ! -e "${runtime_dir}" ]] || fail "${runtime_dir} must not already exist"
[[ ! -e "/etc/systemd/system/${unit_name}" ]] \
  || fail "${unit_name} already exists"
[[ -z "$(systemctl list-units --all --full --no-legend "${cleanup_unit_name}")" ]] \
  || fail "${cleanup_unit_name} already exists"
[[ ! -e "${cleanup_helper}" ]] || fail "${cleanup_helper} already exists"
[[ -x /usr/bin/systemd-run ]] || fail "/usr/bin/systemd-run is unavailable"
! id "${runner_user}" >/dev/null 2>&1 \
  || fail "${runner_user} must not already exist"
! getent group "${runner_user}" >/dev/null 2>&1 \
  || fail "${runner_user} group must not already exist"

trap cleanup_partial_install EXIT
trap on_signal HUP INT TERM

IFS= read -r jit_config || [[ -n "${jit_config:-}" ]] \
  || fail "JIT configuration was not provided"
jit_config="${jit_config//$'\r'/}"
[[ "${jit_config}" =~ ^[A-Za-z0-9_+=/-]+$ ]] \
  || fail "JIT configuration is invalid"

useradd --system --user-group --no-create-home --home-dir "${runner_home}" \
  --shell /usr/sbin/nologin "${runner_user}"
created_user="true"

install -d -o root -g root -m 0755 "${runner_dir}"
created_runner_dir="true"
install -d -o root -g "${runner_user}" -m 0710 "/run/market-signal-runner"
created_runtime_dir="true"
install -d -o "${runner_user}" -g "${runner_user}" -m 0700 "${runner_home}"
install -d -o root -g root -m 0700 "${runtime_dir}"

archive="$(mktemp)"
curl --fail --silent --show-error --location \
  --retry 4 --retry-all-errors \
  "https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-linux-x64-${runner_version}.tar.gz" \
  --output "${archive}"
printf '%s  %s\n' "${runner_sha256}" "${archive}" | sha256sum --check --status
tar -xzf "${archive}" -C "${runner_dir}"
rm -f -- "${archive}"
archive=""
chown -R "${runner_user}:${runner_user}" "${runner_dir}"

printf 'JIT_CONFIG=%q\n' "${jit_config}" >"${runtime_dir}/environment"
chmod 0600 "${runtime_dir}/environment"

cat >"${cleanup_helper}" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
rm -rf -- '${runner_dir}' '${runner_home}' '${runtime_dir}'
rm -rf -- '/run/market-signal-runner'
userdel '${runner_user}' >/dev/null 2>&1 || true
groupdel '${runner_user}' >/dev/null 2>&1 || true
rm -f -- '/etc/systemd/system/${unit_name}'
rm -f -- '${cleanup_helper}'
systemctl daemon-reload
EOF
chown root:root "${cleanup_helper}"
chmod 0755 "${cleanup_helper}"
created_cleanup_helper="true"

cat >"/etc/systemd/system/${unit_name}" <<EOF
[Unit]
Description=One-job Market Signal GitHub Actions runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${runner_user}
Group=${runner_user}
WorkingDirectory=${runner_dir}
Environment=HOME=${runner_home}
EnvironmentFile=${runtime_dir}/environment
ExecStart=/bin/bash -lc 'exec ./run.sh --jitconfig "\${JIT_CONFIG}"'
ExecStopPost=+/usr/bin/systemd-run --quiet --collect --wait --unit=${cleanup_unit_name} ${cleanup_helper}
Restart=no
TimeoutStartSec=40min
TimeoutStopSec=2min
RuntimeMaxSec=80min
KillMode=control-group
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${runner_dir} ${runner_home}

[Install]
WantedBy=multi-user.target
EOF
chown root:root "/etc/systemd/system/${unit_name}"
chmod 0644 "/etc/systemd/system/${unit_name}"
created_unit="true"

systemctl daemon-reload
trap '' HUP INT TERM
if timeout 30s systemctl start "${unit_name}"; then
  systemd_owns_cleanup="true"
else
  systemctl stop "${unit_name}" >/dev/null 2>&1 || true
  fail "could not start ${unit_name}"
fi
trap on_signal HUP INT TERM
systemctl --no-pager --full status "${unit_name}"
echo "PASS: one-job JIT production runner started."
