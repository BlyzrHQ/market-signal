#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

[[ "$#" -eq 2 ]] || exit 64
[[ "$1" == "-c" ]] || exit 64
[[ "$2" == "/usr/local/sbin/market-signal-feedback-monitor-ssh" ]] || exit 64

exec /usr/local/sbin/market-signal-feedback-monitor-ssh
