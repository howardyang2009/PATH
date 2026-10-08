#!/usr/bin/env bash
# Nightly backup (docs/spec/path-website.md §9), run by the launchd agent com.path.backup: a
# snapshot of the project, stored encrypted by restic in Backblaze B2, then pruned to 7 daily,
# 4 weekly and 6 monthly. Settings come from ~/.config/path/backup.env (backup.env.example).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck source=/dev/null
source "${PATH_BACKUP_ENV:-$HOME/.config/path/backup.env}"
set +a

# A fixed staging path, so restic sees the same path each night and finds the parent snapshot.
staging="${PATH_BACKUP_STAGING:-$HOME/Library/Caches/path-backup/snapshot}"
rm -rf "$staging"
mkdir -p "$(dirname "$staging")"
"$here/../node_modules/.bin/tsx" "$here/../bin/path-server.ts" backup \
  --project "$PATH_PROJECT_DIR" --out "$staging"
restic backup --tag path "$staging"
restic forget --tag path --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
rm -rf "$staging"
echo "Backup done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
