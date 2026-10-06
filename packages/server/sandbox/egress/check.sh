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

# A pf `block drop` looks like a connect that never completes: curl exits 28 with no connect time.
# `--max-time` ends a probe that did connect, such as an SMTP session held open.
container run --rm --network path --entrypoint sh "$image" -c '
  failed=0
  connected() {
    code=0
    out="$(curl -sS -o /dev/null --connect-timeout 4 --max-time 6 -w "%{time_connect}" "$1" 2>/dev/null)" || code=$?
    [ "$code" -ne 28 ] || [ "$out" != "0.000000" ]
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
  allowed "internet HTTPS"          "https://example.com/"
  exit "$failed"
' sh "$router"
