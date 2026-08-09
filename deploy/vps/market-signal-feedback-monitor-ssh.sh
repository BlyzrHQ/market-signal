#!/bin/bash
set -Eeuo pipefail

export LC_ALL=C

command_text="${SSH_ORIGINAL_COMMAND:-}"
[[ "${command_text}" =~ ^[A-Za-z0-9:_-]+( [A-Za-z0-9:_-]+){0,4}$ ]] || exit 64
IFS=' ' read -r -a parts <<<"${command_text}"

case "${parts[0]:-}" in
  health|claim)
    [[ "${#parts[@]}" -eq 1 ]] || exit 64
    ;;
  ack)
    [[ "${#parts[@]}" -eq 5 ]] || exit 64
    [[ "${parts[1]}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || exit 64
    [[ "${parts[2]}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || exit 64
    [[ "${parts[3]}" =~ ^[a-f0-9]{64}$ ]] || exit 64
    [[ "${parts[4]}" =~ ^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$ ]] || exit 64
    ;;
  *) exit 64 ;;
esac

exec sudo /usr/local/sbin/market-signal-feedback-monitor "${parts[@]}"
