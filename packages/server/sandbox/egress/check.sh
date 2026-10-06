#!/usr/bin/env bash
# Probes egress from one VM on the `path` network: every blocked target must time out, and an
# internet HTTPS request must work. Run as the login user after install.sh, and after a reboot.
# Usage: check.sh <run image>   (default: $PATH_SANDBOX_IMAGE)
set -euo pipefail

image="${1:-${PATH_SANDBOX_IMAGE:-}}"
if [[ -z $image ]]; then
  echo "Usage: check.sh <run image>" >&2
  exit 2
fi
router="$(route -n get default | awk '/gateway:/ { print $2 }')"
if [[ -z $router ]]; then
  echo "No default route on the host, so no LAN router to probe." >&2
  exit 2
fi

# A listener on the host, so the gateway probe can tell a block from a closed port.
nc -l 8765 </dev/null >/dev/null 2>&1 &
listener=$!
trap 'kill "$listener" 2>/dev/null || true' EXIT

# A pf `block drop` looks like a connect that never completes. A refused connect reached the host;
# a DNS failure (curl 6) proves nothing, so it counts as reached. `--max-time` ends a probe that did
# connect, such as an SMTP session held open. 10.0.0.1, 172.16.0.1 and 169.254.169.254 time out on
# a LAN without them too, so only the anchor's rules (`sudo pfctl -a path -s rules`) show those
# ranges are blocked.
container run --rm --network path --entrypoint sh "$image" -c '
  failed=0
  connected() {
    code=0
    out="$(curl -sS -o /dev/null --connect-timeout 4 --max-time 6 -w "%{time_connect}" "$1" 2>/tmp/err)" || code=$?
    [ "$out" != "0.000000" ] || [ "$code" -eq 6 ] || grep -q "refused" /tmp/err
  }
  blocked() {
    if connected "$2"; then echo "FAIL    reached  $1"; failed=1; else echo "ok      blocked  $1"; fi
  }
  allowed() {
    if curl -sS -o /dev/null --max-time 10 "$2"; then echo "ok      reached  $1"; else echo "FAIL    blocked  $1"; failed=1; fi
  }
  blocked "LAN router $1"           "http://$1/"
  blocked "host gateway port 8765"  "http://192.168.100.1:8765/"
  blocked "10.0.0.1"                "http://10.0.0.1/"
  blocked "172.16.0.1"              "http://172.16.0.1/"
  blocked "169.254.169.254"         "http://169.254.169.254/"
  blocked "100.100.100.100"         "http://100.100.100.100/"
  blocked "SMTP 25"                 "telnet://smtp.gmail.com:25"
  blocked "SMTP 465"                "telnet://smtp.gmail.com:465"
  blocked "SMTP 587"                "telnet://smtp.gmail.com:587"
  blocked "IPv6 internet"           "https://[2606:4700:4700::1111]/"
  allowed "internet HTTPS"          "https://example.com/"
  exit "$failed"
' sh "$router"
