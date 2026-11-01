#!/bin/sh
# Nightly scheduler for the cron sidecar.
#
# A plain sleep-until-the-hour loop rather than cron or supercronic: no extra
# binary to install, logs land on stdout where `docker compose logs` finds
# them, and there is nothing here that can rot in five years.
set -eu

RUN_AT_HOUR="${LEDGER_CRON_HOUR:-3}"   # local hour, 0-23

# Touched every time round the loop. This container serves no HTTP, so its
# healthcheck reads this file's age instead — see docker-compose.yml. A wedged
# sleep or a nightly.sh that hangs forever both stop the file from advancing,
# which is the only failure mode "the process is running" cannot see.
HEARTBEAT="${LEDGER_CRON_HEARTBEAT:-/tmp/cron-heartbeat}"
beat() { : > "$HEARTBEAT"; }

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

beat
log "cron sidecar up; nightly job at ${RUN_AT_HOUR}:00 ${TZ:-local}"

while true; do
    beat
    now_h=$(date +%-H)
    now_m=$(date +%-M)
    # Seconds until the next occurrence of RUN_AT_HOUR:00.
    secs=$(( ((RUN_AT_HOUR - now_h + 24) % 24) * 3600 - now_m * 60 ))
    [ "$secs" -le 0 ] && secs=$((secs + 86400))
    log "sleeping ${secs}s until next run"
    sleep "$secs"

    beat
    log "--- nightly start ---"
    if /app/scripts/nightly.sh; then
        log "--- nightly ok ---"
    else
        # Never exit: a failed sync tonight must not stop tomorrow's. The
        # failure is already in sync_log; this line is for the container log.
        log "--- nightly FAILED (exit $?) — see: ledger sync-log ---"
    fi
done
