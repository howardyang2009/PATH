#!/bin/bash
# Loads pf anchor `path` and enables pf. Runs as root at boot from the launchd daemon
# com.path.egress, then writes the status file the hosted Server checks before it starts.
set -euo pipefail

anchor=/etc/pf.anchors/path
status=/var/run/path-egress.status
rm -f "$status"

# macOS updates can replace /etc/pf.conf, so the anchor point is added here, not in that file.
{
  cat /etc/pf.conf
  grep -qx 'anchor "path"' /etc/pf.conf || echo 'anchor "path"'
} | pfctl -f -
pfctl -a path -f "$anchor"
pfctl -E

{
  echo "boottime=$(sysctl -n kern.boottime | sed -E 's/^\{ sec = ([0-9]+),.*/\1/')"
  pfctl -s info | grep '^Status:'
  pfctl -a path -s rules
} >"$status.tmp"
chmod 644 "$status.tmp"
mv "$status.tmp" "$status"
