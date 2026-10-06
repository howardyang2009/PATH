#!/usr/bin/env bash
# Installs the egress filter for run VMs (docs/spec/path-website.md §10): the `path` container
# network, pf anchor `path` and the launchd daemon that loads it at every boot.
# Run as the login user (`container` refuses root); it asks for sudo once.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [[ $EUID -eq 0 ]]; then
  echo "Run install.sh as the login user, not root: container refuses root." >&2
  exit 1
fi

if ! container network inspect path >/dev/null 2>&1; then
  container network create path --subnet 192.168.100.0/24 >/dev/null
fi
read -r net4 gw net6 < <(container network inspect path | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].status;
  console.log(s.ipv4Subnet, s.ipv4Gateway, s.ipv6Subnet);')
if [[ $net4 != 192.168.100.0/24 || $gw != 192.168.100.1 ]]; then
  echo "Network path is $net4 via $gw; path.anchor expects 192.168.100.0/24 via 192.168.100.1." >&2
  exit 1
fi

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed "s|@PATH_NET6@|$net6|" "$here/path.anchor" >"$rendered"

# Root-owned copies, so the daemon never runs a file the login user can change.
sudo /bin/bash -euo pipefail -c '
  pfctl -n -a path -f "$1"
  mkdir -p /usr/local/libexec
  install -o root -g wheel -m 644 "$1" /etc/pf.anchors/path
  install -o root -g wheel -m 755 "$2" /usr/local/libexec/path-egress-load.sh
  install -o root -g wheel -m 644 "$3" /Library/LaunchDaemons/com.path.egress.plist
  launchctl bootout system/com.path.egress 2>/dev/null || true
  launchctl bootstrap system /Library/LaunchDaemons/com.path.egress.plist
' _ "$rendered" "$here/load-anchor.sh" "$here/com.path.egress.plist"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f /var/run/path-egress.status ]] && break
  sleep 1
done
if [[ ! -f /var/run/path-egress.status ]]; then
  echo "The daemon wrote no status; see /var/log/path-egress.log." >&2
  exit 1
fi
cat /var/run/path-egress.status
echo "Installed. Check it from a VM with: $here/check.sh <run image>"
