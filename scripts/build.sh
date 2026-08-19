#!/usr/bin/env bash
# Build dsh-prompt-kmanager: link the checkout's packages and compile src ->
# lib (tsc) then bundle the runtime entries (tsdown).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
node scripts/build.mjs "$@"
