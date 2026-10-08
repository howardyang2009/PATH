#!/usr/bin/env bash
# Installs the nightly backup (docs/spec/path-website.md §9) as the launchd agent com.path.backup.
# Run as the login user, after filling ~/.config/path/backup.env and running `restic init` once.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
env_file="$HOME/.config/path/backup.env"
if [[ ! -f $env_file ]]; then
  echo "Create $env_file from $here/backup.env.example first." >&2
  exit 1
fi
command -v restic >/dev/null || { echo "Install restic first: brew install restic" >&2; exit 1; }

agent="$HOME/Library/LaunchAgents/com.path.backup.plist"
mkdir -p "$(dirname "$agent")" "$HOME/Library/Logs"
sed -e "s|@BACKUP_SH@|$here/backup.sh|" \
  -e "s|@LOG@|$HOME/Library/Logs/path-backup.log|" \
  "$here/com.path.backup.plist" >"$agent"
plutil -lint "$agent" >/dev/null
launchctl bootout "gui/$UID/com.path.backup" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$agent"
echo "Installed. Run one backup now: launchctl kickstart gui/$UID/com.path.backup"
echo "Log: $HOME/Library/Logs/path-backup.log"
