#!/usr/bin/env bash
# One-time GitHub setup. Run YOURSELF in a Mac terminal (it uses your gh login, which lives in
# the macOS Keychain that the agent's SSH session cannot read). Contains no secrets.
#   bash setup-github.sh
# 1. Creates the private repo DomBarker99/offline-emergency-agent (skips if it exists)
# 2. Adds the agent's public key as a WRITE deploy key for this repo only
# 3. Waits for the agent to push, then clones to ~/Developer/offline-emergency-agent and installs deps
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
REPO=DomBarker99/offline-emergency-agent
AGENT_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPXKOLXljmgvNAniNKcvwDlL5cHh6k/UqlBU6oYJXYns agent deploy key: DomBarker99/offline-emergency-agent (2026-10-22)'
DEST="$HOME/Developer/offline-emergency-agent"

gh auth status >/dev/null || { echo "Run: gh auth login"; exit 1; }

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Repo $REPO already exists."
else
  gh repo create "$REPO" --private --description "Local, offline emergency response agent with a localized knowledge pack (SpartHill Hacks 2026)"
fi

if gh repo deploy-key list -R "$REPO" | grep -q "sparthill agent"; then
  echo "Agent deploy key already present."
else
  KEYFILE=$(mktemp /tmp/agent-key.XXXX.pub); echo "$AGENT_KEY" > "$KEYFILE"
  gh repo deploy-key add "$KEYFILE" --allow-write -R "$REPO" -t "sparthill agent (workhorse)"
fi
echo "Deploy keys:"; gh repo deploy-key list -R "$REPO"

echo "Waiting for the agent to push main (up to 10 minutes)..."
for i in $(seq 1 120); do
  git ls-remote "https://github.com/$REPO.git" main 2>/dev/null | grep -q main && break
  sleep 5
done

if [ -d "$DEST/.git" ]; then
  echo "Clone already exists at $DEST; pulling."; git -C "$DEST" pull --ff-only
else
  mkdir -p "$HOME/Developer"; gh repo clone "$REPO" "$DEST"
fi
cd "$DEST" && npm ci --no-audit --no-fund && npm run typecheck && echo "Ready: $DEST"
