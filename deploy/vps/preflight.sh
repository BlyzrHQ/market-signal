#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

domain="${MARKET_SIGNAL_DOMAIN:-}"
expected_ipv4="${MARKET_SIGNAL_EXPECTED_IPV4:-}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "preflight must run as root"
[[ -n "${domain}" ]] || fail "MARKET_SIGNAL_DOMAIN is required"
[[ "${expected_ipv4}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] \
  || fail "MARKET_SIGNAL_EXPECTED_IPV4 must be an IPv4 address"
IFS=. read -r octet1 octet2 octet3 octet4 <<<"${expected_ipv4}"
for octet in "${octet1}" "${octet2}" "${octet3}" "${octet4}"; do
  (( 10#${octet} <= 255 )) || fail "MARKET_SIGNAL_EXPECTED_IPV4 is invalid"
done

source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
  || fail "host must be Ubuntu 24.04"

command -v docker >/dev/null || fail "Docker is unavailable"
docker info >/dev/null || fail "Docker daemon is unavailable"
docker compose version >/dev/null || fail "Docker Compose is unavailable"
command -v dig >/dev/null || fail "dig is unavailable"

resolved_ipv4="$(dig +short A "${domain}" | sort -u)" \
  || fail "A-record lookup failed for ${domain}"
[[ "${resolved_ipv4}" == "${expected_ipv4}" ]] \
  || fail "${domain} A records are '${resolved_ipv4}', expected only ${expected_ipv4}"
resolved_ipv6="$(dig +short AAAA "${domain}" | sort -u)" \
  || fail "AAAA-record lookup failed for ${domain}"
[[ -z "${resolved_ipv6}" ]] \
  || fail "${domain} has unexpected AAAA records: ${resolved_ipv6//$'\n'/,}"

for directory in /var/lib/market-signal /var/backups/market-signal; do
  [[ -d "${directory}" ]] || fail "${directory} is missing"
  owner="$(stat -c '%u:%g' "${directory}")"
  mode="$(stat -c '%a' "${directory}")"
  [[ "${owner}" == "10001:10001" ]] \
    || fail "${directory} owner is ${owner}, expected 10001:10001"
  [[ "${mode}" == "750" ]] \
    || fail "${directory} mode is ${mode}, expected 750"
done

ufw_status="$(ufw status)" || fail "UFW status could not be read"
grep -Fq "Status: active" <<<"${ufw_status}" || fail "UFW is not active"
grep -Eq '^(22/tcp|OpenSSH)[[:space:]]+ALLOW' <<<"${ufw_status}" \
  || fail "SSH is not allowed by UFW"
grep -Eq '^80/tcp[[:space:]]+ALLOW' <<<"${ufw_status}" \
  || fail "HTTP is not allowed by UFW"
grep -Eq '^443/tcp[[:space:]]+ALLOW' <<<"${ufw_status}" \
  || fail "HTTPS is not allowed by UFW"
grep -Eq '^443/udp[[:space:]]+ALLOW' <<<"${ufw_status}" \
  || fail "HTTP/3 is not allowed by UFW"

unexpected_public_tcp="$(
  ss -H -lntp |
    awk '{
      address = $4
      host = address
      sub(/:[^:]+$/, "", host)
      port = address
      sub(/^.*:/, "", port)
      if (host !~ /^127\./ && host != "[::1]" && host != "::1" &&
          port != "22") print address
    }' |
    sort -u
)" || fail "public TCP listeners could not be inspected"
[[ -z "${unexpected_public_tcp}" ]] \
  || fail "unexpected public TCP listeners: ${unexpected_public_tcp//$'\n'/,}"

unexpected_public_udp="$(
  ss -H -lnup |
    awk '{
      address = $4
      host = address
      sub(/:[^:]+$/, "", host)
      port = address
      sub(/^.*:/, "", port)
      if (host !~ /^127\./ && host != "[::1]" && host != "::1" &&
          port != "68") print address
    }' |
    sort -u
)" || fail "public UDP listeners could not be inspected"
[[ -z "${unexpected_public_udp}" ]] \
  || fail "unexpected public UDP listeners: ${unexpected_public_udp//$'\n'/,}"

available_kib="$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)"
[[ "${available_kib}" -ge 1048576 ]] || fail "less than 1 GiB memory available"

available_disk_kib="$(df --output=avail /var/lib/market-signal | tail -n 1)"
available_disk_kib="${available_disk_kib//[[:space:]]/}"
[[ "${available_disk_kib}" -ge 10485760 ]] \
  || fail "less than 10 GiB disk available"

grep -Fq 'APT::Periodic::Update-Package-Lists "1";' \
  /etc/apt/apt.conf.d/20auto-upgrades \
  || fail "automatic package-list updates are disabled"
grep -Fq 'APT::Periodic::Unattended-Upgrade "1";' \
  /etc/apt/apt.conf.d/20auto-upgrades \
  || fail "unattended security upgrades are disabled"

echo "PASS: ${domain} VPS preflight completed for ${expected_ipv4}."
