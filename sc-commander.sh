#!/usr/bin/env bash
# SC Commander - StarCraft voice notifications for Claude Code
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/sc-commander.py"
