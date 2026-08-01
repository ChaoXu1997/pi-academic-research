#!/usr/bin/env bash
#
# link-subagents.sh — link the pi-academic-research subagents into a target
# project's .pi/subagents/ directory.
#
# Pi does not auto-load subagent definitions from packages; they must live in
# the project's .pi/subagents/ (or the global ~/.pi/agent/subagents/). This
# script symlinks every adapted subagent so Pi's pi-subagents-j0k3r runtime
# picks them up, and updates automatically when the package is updated.
#
# Usage:
#   bash link-subagents.sh [project-dir]
#     project-dir defaults to the current working directory.
#
# After linking, run `pi config` or restart Pi so the new subagents register.

set -euo pipefail

PROJECT="${1:-$PWD}"

# Resolve the package root from this script's location (../ of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$PKG_ROOT/subagents"
DEST="$PROJECT/.pi/subagents"

if [ ! -d "$SRC" ]; then
  echo "ERROR: subagents source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

count=0
for f in "$SRC"/*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  ln -sf "$SRC/$name" "$DEST/$name"
  count=$((count + 1))
done

echo "Linked $count subagents from"
echo "  $SRC"
echo "into"
echo "  $DEST"
echo ""
echo "Restart Pi (or run pi config) to register them. Verify with: subagent_list_agents"
