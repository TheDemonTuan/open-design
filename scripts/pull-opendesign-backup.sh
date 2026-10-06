#!/usr/bin/env bash
set -euo pipefail

# Pull OpenDesign backups from VPS to local machine
# Uses ssh alias 'vps'

LOCAL_BACKUP_DIR="${HOME}/DesignHandoff/backups"
REMOTE_BACKUP_DIR="/opt/opendesign/backups"

mkdir -p "$LOCAL_BACKUP_DIR"
chmod 700 "$LOCAL_BACKUP_DIR"

echo "==> Pulling OpenDesign backups from VPS to ${LOCAL_BACKUP_DIR}..."
rsync -avz --progress --no-p --chmod=D700,F600 "vps:${REMOTE_BACKUP_DIR}/" "$LOCAL_BACKUP_DIR/"

echo "==> Local backups synced successfully:"
ls -lh "$LOCAL_BACKUP_DIR"
