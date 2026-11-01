#!/bin/sh
# Nightly: sync the trailing 3 days, refresh the leagues, then back up
# (BRIEF §11).
#
# Every leg's exit code is captured but none aborts the next — a failed Garmin
# sync is no reason to skip protecting the data that is already there, and a
# league page that 404s the day a session ends is no reason to skip either.
set -u

DB="${LEDGER_DB_PATH:-/data/ledger.db}"

echo "sync: starting"
ledger sync --days "${LEDGER_SYNC_DAYS:-3}"
sync_rc=$?
echo "sync: exit ${sync_rc}"

# Scrapes both league pages: standings, and scorelines for anything played
# since the last run. `ledger leagues` returns 0 when an individual league
# fails — refresh_all() reports that per league rather than raising — so a
# non-zero here means the command itself broke.
echo "leagues: starting"
ledger leagues
leagues_rc=$?
echo "leagues: exit ${leagues_rc}"

/app/scripts/backup.sh
backup_rc=$?

# Non-zero if any leg failed, so the caller's log shows it.
[ "$sync_rc" -eq 0 ] && [ "$leagues_rc" -eq 0 ] && [ "$backup_rc" -eq 0 ]
