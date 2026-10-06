#!/usr/bin/env bash
set -euo pipefail

# OpenDesign Automated Database & Artifacts Backup
# Runs on VPS via systemd timer or scheduled automation

DATA_DIR="/opt/opendesign/data"
BACKUP_DIR="/opt/opendesign/backups"
DB_FILE="${DATA_DIR}/open-design.db"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
BACKUP_PREFIX="${BACKUP_DIR}/opendesign-${TIMESTAMP}"
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "==> [${TIMESTAMP}] Starting OpenDesign backup..."

if [ -f "$DB_FILE" ]; then
    TARGET_DB="${BACKUP_PREFIX}.db"
    echo "Backing up SQLite database safely using online backup API..."
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB_FILE" ".backup '${TARGET_DB}'"
    else
        # Fallback to python sqlite3 backup
        python3 -c "
import sqlite3
src = sqlite3.connect('${DB_FILE}')
dst = sqlite3.connect('${TARGET_DB}')
src.backup(dst)
dst.close()
src.close()
"
    fi
    chmod 600 "$TARGET_DB"
    echo "Database backup created: ${TARGET_DB} ($(stat -c%s "$TARGET_DB") bytes)"
else
    echo "Warning: Database file $DB_FILE not found (first run before startup?)"
fi

# Backup artifacts if directory exists
if [ -d "${DATA_DIR}/artifacts" ]; then
    TARGET_ARTIFACTS="${BACKUP_PREFIX}-artifacts.tar.gz"
    echo "Archiving artifacts..."
    tar -czf "$TARGET_ARTIFACTS" -C "$DATA_DIR" artifacts
    chmod 600 "$TARGET_ARTIFACTS"
    echo "Artifacts backup created: ${TARGET_ARTIFACTS} ($(stat -c%s "$TARGET_ARTIFACTS") bytes)"
fi

# Cleanup old backups
echo "Pruning backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "opendesign-*" -type f -mtime +"$RETENTION_DAYS" -delete

echo "==> [${TIMESTAMP}] Backup completed successfully."
