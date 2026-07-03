#!/usr/bin/env bash
# Crivacy PostgreSQL restore script.
#
# Restores a backup created by backup-postgres.sh.
#
# Usage:
#   /opt/crivacy/scripts/restore-postgres.sh /opt/crivacy/backups/crivacy_20260412_030000.sql.gz
#   /opt/crivacy/scripts/restore-postgres.sh latest
#
# WARNING: This will DROP and recreate the database. Use with caution.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.backup-env" ]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.backup-env"
fi

PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-crivacy}"
PG_DB="${PG_DB:-crivacy}"
BACKUP_DIR="${BACKUP_DIR:-/opt/crivacy/backups}"

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup-file|latest>"
  echo ""
  echo "Available backups:"
  ls -lht "$BACKUP_DIR"/${PG_DB}_*.sql.gz 2>/dev/null | head -10
  exit 1
fi

if [ "$BACKUP_FILE" = "latest" ]; then
  BACKUP_FILE="${BACKUP_DIR}/${PG_DB}_latest.sql.gz"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "=== Crivacy Restore: $(date -u) ==="
echo "Restoring from: $BACKUP_FILE"
echo "Target: ${PG_DB}@${PG_HOST}:${PG_PORT}"
echo ""
echo "WARNING: This will DROP and recreate the '${PG_DB}' database."
echo "Press Ctrl+C to abort, or Enter to continue..."
read -r

# Stop the API service first
echo "Stopping crivacy-api service..."
systemctl stop crivacy-api || true

# Drop and recreate database
echo "Dropping and recreating database..."
psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -c "DROP DATABASE IF EXISTS ${PG_DB};"
psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"

# Restore
echo "Restoring backup..."
gunzip -c "$BACKUP_FILE" | pg_restore \
  -h "$PG_HOST" \
  -p "$PG_PORT" \
  -U "$PG_USER" \
  -d "$PG_DB" \
  --no-owner \
  --no-privileges \
  --verbose \
  2>&1

# Restart API service
echo "Restarting crivacy-api service..."
systemctl start crivacy-api

# Health check
echo "Waiting for health check..."
for i in $(seq 1 12); do
  if curl -sf http://127.0.0.1:3001/api/v1/health >/dev/null 2>&1; then
    echo "Health check passed!"
    break
  fi
  echo "Attempt $i/12 — waiting 5s..."
  sleep 5
done

echo "=== Restore complete: $(date -u) ==="
