#!/usr/bin/env bash
set -euo pipefail

# SC Commander Uninstaller

INSTALL_DIR="$HOME/.claude/hooks/sc-commander"
SKILL_DIR="$HOME/.claude/skills/sc-commander-config"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== SC Commander Uninstaller ==="
echo ""

# --- Remove hooks from settings.json ---
if [[ -f "$SETTINGS_FILE" ]]; then
    python3 -c "
import json

with open('$SETTINGS_FILE') as f:
    settings = json.load(f)

hooks = settings.get('hooks', {})
removed = 0
events_to_delete = []

for event, blocks in hooks.items():
    original_len = len(blocks)
    blocks[:] = [
        block for block in blocks
        if not any(
            'sc-commander' in h.get('command', '')
            for h in block.get('hooks', [])
        )
    ]
    removed += original_len - len(blocks)
    if not blocks:
        events_to_delete.append(event)

for event in events_to_delete:
    del hooks[event]

with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print(f'  Removed {removed} hook(s) from settings.json')
"
else
    echo "  No settings.json found — skipping hook removal"
fi

# --- Remove skill ---
if [[ -d "$SKILL_DIR" ]]; then
    rm -rf "$SKILL_DIR"
    echo "  Removed skill directory"
fi

# --- Prompt for config/cache removal ---
if [[ -d "$INSTALL_DIR" ]]; then
    echo ""
    read -p "Remove config.json and cache? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$INSTALL_DIR"
        echo "  Removed $INSTALL_DIR (all files)"
    else
        # Remove everything except config.json and cache/
        find "$INSTALL_DIR" -maxdepth 1 -type f ! -name 'config.json' -delete
        echo "  Removed hook scripts (kept config.json and cache/)"
    fi
fi

echo ""
echo "=== Uninstall Complete ==="
echo "SC Commander has been removed from Claude Code."
