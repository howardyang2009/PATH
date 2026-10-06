#!/usr/bin/env bash
# Builds the run image with Apple `container` (ADR 0091) and prints its tag.
# Usage: build-run-image.sh [tag]   (default: path-run:<git describe>)
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
tag="${1:-path-run:$(git -C "$root" describe --tags --always --dirty)}"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT

# Only what the VM runs: the workspace manifests and the schema, engine and server packages.
cp "$root"/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,tsconfig.base.json} "$context/"
for pkg in schema engine server; do
  mkdir -p "$context/packages/$pkg"
  rsync -a --exclude node_modules --exclude dist --exclude test --exclude .vitest \
    "$root/packages/$pkg/" "$context/packages/$pkg/"
done

container build --progress plain --file "$root/packages/server/sandbox/Containerfile" \
  --tag "$tag" "$context" >&2
echo "$tag"
