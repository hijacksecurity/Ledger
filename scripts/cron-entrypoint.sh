#!/bin/sh
# Scheduler for the cron sidecar: the nightly job, and the morning pull.
#
# A plain sleep loop rather than cron or supercronic: no extra binary to
# install, logs land on stdout where `docker compose logs` finds them, and
# there is nothing here that can rot in five years.
#
# It wakes on every quarter hour (:00 :15 :30 :45, local time) and decides:
#
#   RUN_AT_HOUR:00          the nightly — three trailing days, leagues, backup.
#   MORNING_FROM..UNTIL     `ledger sync-morning`, every MORNING_EVERY minutes.
#                           One call to ask whether last night's sleep is in;
#                           once it is, the rest of the morning's numbers, and
#                           then nothing until tomorrow (it says "settled").
#
# The nightly at 03:00 cannot carry the night being slept, so without the
# morning pull sleep, HRV and readiness waited a day or a tap of the button.
set -eu

RUN_AT_HOUR="${LEDGER_CRON_HOUR:-3}"            # local hour, 0-23
MORNING_FROM="${LEDGER_MORNING_FROM:-4}"        # first local hour of the pull
MORNING_UNTIL="${LEDGER_MORNING_UNTIL:-14}"     # the pull stops at this hour
MORNING_EVERY="${LEDGER_MORNING_EVERY_MIN:-15}" # minutes; a multiple of 15

# Touched every time round the loop. This container serves no HTTP, so its
# healthcheck reads this file's age instead — see docker-compose.yml. A wedged
# sleep or a job that hangs forever both stop the file from advancing, which
# is the only failure mode "the process is running" cannot see.
HEARTBEAT="${LEDGER_CRON_HEARTBEAT:-/tmp/cron-heartbeat}"
beat() { : > "$HEARTBEAT"; }

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

beat
log "cron sidecar up; nightly at ${RUN_AT_HOUR}:00, morning pull ${MORNING_FROM}:00-${MORNING_UNTIL}:00 every ${MORNING_EVERY} min, ${TZ:-local}"

while true; do
    beat
    # Seconds to the next quarter hour, plus a few so the wake lands inside
    # the minute it is aiming for rather than a breath before it.
    now_m=$(date +%-M)
    now_s=$(date +%-S)
    secs=$(( (15 - now_m % 15) * 60 - now_s + 5 ))
    sleep "$secs"

    beat
    h=$(date +%-H)
    m=$(date +%-M)
    q=$(( m - m % 15 ))

    if [ "$h" -eq "$RUN_AT_HOUR" ] && [ "$q" -eq 0 ]; then
        log "--- nightly start ---"
        if /app/scripts/nightly.sh; then
            log "--- nightly ok ---"
        else
            # Never exit: a failed sync tonight must not stop tomorrow's. The
            # failure is already in sync_log; this line is for the container log.
            log "--- nightly FAILED (exit $?) — see: ledger sync-log ---"
        fi
        continue
    fi

    if [ "$h" -ge "$MORNING_FROM" ] && [ "$h" -lt "$MORNING_UNTIL" ] \
        && [ $(( (h * 60 + q) % MORNING_EVERY )) -eq 0 ]; then
        # Quiet on success: the one line it prints says waiting / settling /
        # settled and how many calls that cost.
        ledger sync-morning || log "morning pull failed (exit $?) — see: ledger sync-log"
    fi
done
