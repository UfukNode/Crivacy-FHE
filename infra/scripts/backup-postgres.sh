#!/usr/bin/env bash
# Crivacy PostgreSQL backup script.
#
# Creates a compressed pg_dump of the Crivacy database, rotates old backups,
# and optionally syncs to B2 (Backblaze) object storage.
#
# Usage:
#   /opt/crivacy/scripts/backup-postgres.sh
#
# Cron (daily at 03:00 UTC):
#   0 3 * * * /opt/crivacy/scripts/backup-postgres.sh >> /var/log/crivacy/backup.log 2>&1
#
# Environment (from /opt/crivacy/scripts/.backup-env):
#   PG_HOST, PG_PORT, PG_USER, PG_DB
#   BACKUP_DIR (default: /opt/crivacy/backups)
#   BACKUP_RETENTION_DAYS (default: 30)
#   B2_ENABLED (default: false)
#   B2_BUCKET (Backblaze bucket name)
#   B2_KEY_ID, B2_APPLICATION_KEY

set -euo pipefail

# Load config
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.backup-env" ]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.backup-env"
fi

# Defaults
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-crivacy}"
PG_DB="${PG_DB:-crivacy}"
BACKUP_DIR="${BACKUP_DIR:-/opt/crivacy/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
B2_ENABLED="${B2_ENABLED:-false}"

# Derived
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/${PG_DB}_${TIMESTAMP}.sql.gz"
BACKUP_LATEST="${BACKUP_DIR}/${PG_DB}_latest.sql.gz"

echo "=== Crivacy Backup: $(date -u) ==="
echo "Database: ${PG_DB}@${PG_HOST}:${PG_PORT}"

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Dump database (compressed)
echo "Creating backup: ${BACKUP_FILE}"
pg_dump \
  -h "$PG_HOST" \
  -p "$PG_PORT" \
  -U "$PG_USER" \
  -d "$PG_DB" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --verbose \
  2>&1 | gzip > "$BACKUP_FILE"

# Verify backup is non-empty
BACKUP_SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null)
if [ "$BACKUP_SIZE" -lt 1024 ]; then
  echo "ERROR: Backup file is suspiciously small (${BACKUP_SIZE} bytes)"
  rm -f "$BACKUP_FILE"
  exit 1
fi

echo "Backup created: ${BACKUP_FILE} (${BACKUP_SIZE} bytes)"

# Update latest symlink
ln -sf "$BACKUP_FILE" "$BACKUP_LATEST"

# Rotate old backups
echo "Cleaning backups older than ${BACKUP_RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "${PG_DB}_*.sql.gz" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete -print

# Sync to B2 (optional)
if [ "$B2_ENABLED" = "true" ] && command -v b2 &>/dev/null; then
  echo "Syncing to B2: ${B2_BUCKET}"
  b2 authorize-account "$B2_KEY_ID" "$B2_APPLICATION_KEY" 2>/dev/null
  b2 upload-file "$B2_BUCKET" "$BACKUP_FILE" "crivacy-backups/$(basename "$BACKUP_FILE")"
  echo "B2 upload complete"
elif [ "$B2_ENABLED" = "true" ]; then
  echo "WARNING: B2_ENABLED=true but b2 CLI not found, skipping remote sync"
fi

echo "=== Backup complete: $(date -u) ==="
