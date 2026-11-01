#!/bin/sh
# Timestamped SQLite backup, pruned to the last 30 (BRIEF §11).
#
# Uses `sqlite3 .backup`, not `cp`: with WAL on, copying the file while the
# app holds it open produces a torn database that looks fine until you need it.
#
# If LEDGER_BACKUP_GIT_REMOTE is set, commits the backup directory to a
# PRIVATE repo. The repo must never contain .env or the garth token directory
# — both live outside LEDGER_BACKUP_DIR and the .gitignore written below is a
# second line of defence.
set -eu

DB="${LEDGER_DB_PATH:-/data/ledger.db}"
DIR="${LEDGER_BACKUP_DIR:-/backups}"
KEEP="${LEDGER_BACKUP_KEEP:-30}"
STAMP=$(date '+%Y%m%d-%H%M%S')
OUT="${DIR}/ledger-${STAMP}.db"

[ -f "$DB" ] || { echo "backup: no database at ${DB}, nothing to do"; exit 0; }
mkdir -p "$DIR"

echo "backup: ${DB} -> ${OUT}"
sqlite3 "$DB" ".backup '${OUT}'"

# Verify before trusting it. An unreadable backup is worse than none, because
# you stop worrying about it.
if ! sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -q '^ok$'; then
    echo "backup: FAILED integrity check, removing ${OUT}" >&2
    rm -f "$OUT"
    exit 1
fi

# Prune oldest beyond KEEP.
ls -1t "${DIR}"/ledger-*.db 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    echo "backup: pruning ${old}"
    rm -f "$old"
done

if [ -n "${LEDGER_BACKUP_GIT_REMOTE:-}" ]; then
    cd "$DIR"
    if [ ! -d .git ]; then
        git init -q
        git remote add origin "$LEDGER_BACKUP_GIT_REMOTE"
    fi
    # Belt and braces: secrets must never reach the backup repo.
    printf '.env\n.env.*\n*.token\ntokens/\n' > .gitignore
    git add -A
    if git diff --cached --quiet; then
        echo "backup: nothing new to commit"
    else
        git -c user.email=ledger@localhost -c user.name=ledger \
            commit -qm "backup ${STAMP}"
        git push -q origin HEAD 2>&1 || echo "backup: push failed (kept locally)" >&2
    fi
fi

echo "backup: ok"
