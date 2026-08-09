#!/bin/dash
set -efu

export LC_ALL=C

[ "$#" -eq 2 ] || exit 64
[ "$1" = "-c" ] || exit 64
[ "$2" = "/usr/local/sbin/market-signal-feedback-monitor-ssh" ] || exit 64

exec /usr/bin/env -i LC_ALL=C PATH=/usr/bin:/bin SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}" /usr/local/sbin/market-signal-feedback-monitor-ssh
