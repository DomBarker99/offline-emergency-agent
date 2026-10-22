#!/usr/bin/env bash
# Agent-side check: mirror the source out of the synced folder, install locked deps there, typecheck.
# Keeps node_modules out of /shared (Nextcloud would sync thousands of files to the Mac).
# Usage: bash scripts/agent-check.sh [npm script ...]   (default: typecheck)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="${MIRROR:-$HOME/build/offline-emergency-agent}"
mkdir -p "$MIRROR"
rsync -a --delete --exclude node_modules --exclude .git "$SRC/" "$MIRROR/"
cd "$MIRROR"
# npm install (not ci): updates the lockfile when package.json changed; the Mac uses `npm ci` for exact installs
npm install --no-audit --no-fund
# copy a newly created/updated lockfile back so it gets committed
cp package-lock.json "$SRC/package-lock.json"
for s in "${@:-typecheck}"; do npm run --silent "$s"; done
echo "agent-check ok ($MIRROR)"
