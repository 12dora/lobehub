#!/usr/bin/env bash
# Smoke-test aihub-sandbox: TypeScript (tsx) hello + unzip.
# Usage: scripts/sandbox-image-smoke.sh [image]
set -euo pipefail

IMAGE="${1:-aihub-sandbox:latest}"

echo "sandbox-image-smoke: image=${IMAGE}"

hello="$(
  docker run --rm --user 1000:1000 --entrypoint tsx "${IMAGE}" \
    -e 'console.log("hello-from-tsx")'
)"
if [[ "${hello}" != *hello-from-tsx* ]]; then
  echo "sandbox-image-smoke: expected tsx hello, got: ${hello}" >&2
  exit 1
fi

docker run --rm --user 1000:1000 --entrypoint unzip "${IMAGE}" -v >/dev/null

echo "sandbox-image-smoke: tsx + unzip ok"
