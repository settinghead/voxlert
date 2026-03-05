#!/usr/bin/env bash
set -euo pipefail

# VoiceForge Uninstaller

INSTALL_DIR="$HOME/.claude/hooks/voiceforge"
SKILL_DIR="$HOME/.claude/skills/voiceforge-config"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== VoiceForge Uninstaller ==="
echo ""

# --- Remove hooks from settings.json ---
if [[ -f "$SETTINGS_FILE" ]]; then
    node -e "
const fs = require('fs');

const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
const hooks = settings.hooks || {};
let removed = 0;
const eventsToDelete = [];

for (const [event, blocks] of Object.entries(hooks)) {
    const originalLen = blocks.length;
    hooks[event] = blocks.filter(
        block => !block.hooks || !block.hooks.some(
            h => (h.command || '').includes('voiceforge')
        )
    );
    removed += originalLen - hooks[event].length;
    if (hooks[event].length === 0) eventsToDelete.push(event);
}

for (const event of eventsToDelete) {
    delete hooks[event];
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
console.log('  Removed ' + removed + ' hook(s) from settings.json');
"
else
    echo "  No settings.json found — skipping hook removal"
fi

# --- Remove Cursor hooks ---
CURSOR_HOOKS="$HOME/.cursor/hooks.json"
if [[ -f "$CURSOR_HOOKS" ]]; then
    node -e "
const fs = require('fs');
const p = process.env.CURSOR_HOOKS || '';
if (!p || !fs.existsSync(p)) process.exit(0);
const c = JSON.parse(fs.readFileSync(p, 'utf-8'));
if (!c.hooks || typeof c.hooks !== 'object') process.exit(0);
let removed = 0;
for (const event of Object.keys(c.hooks)) {
    const arr = c.hooks[event];
    if (!Array.isArray(arr)) continue;
    const before = arr.length;
    c.hooks[event] = arr.filter(entry => {
        const cmd = (entry && entry.command) || '';
        return !cmd.includes('voiceforge') && !cmd.includes('cursor-hook');
    });
    removed += before - c.hooks[event].length;
    if (c.hooks[event].length === 0) delete c.hooks[event];
}
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
console.log('  Removed ' + removed + ' Cursor hook(s) from ~/.cursor/hooks.json');
"
else
    echo "  No ~/.cursor/hooks.json found — skipping Cursor hook removal"
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
        rm -rf "$INSTALL_DIR/src"
        echo "  Removed hook scripts (kept config.json and cache/)"
    fi
fi

echo ""
echo "=== Uninstall Complete ==="
echo "VoiceForge has been removed from Claude Code and Cursor."
