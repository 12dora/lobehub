#!/usr/bin/env bash
# Build aihub-sandbox:<version> + :latest. Pass --smoke to run scripts/sandbox-image-smoke.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -p "require('./package.json').version")"
docker build -f Dockerfile.sandbox \
  -t aihub-sandbox:latest \
  -t "aihub-sandbox:${VERSION}" \
  .

if [[ "${1:-}" == "--smoke" ]]; then
  bash "${ROOT}/scripts/sandbox-image-smoke.sh" aihub-sandbox:latest
fi
