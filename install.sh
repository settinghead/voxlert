#!/usr/bin/env bash
set -euo pipefail

# VoiceForge Installer
# Installs VoiceForge hooks into Claude Code

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.claude/hooks/voiceforge"
SKILL_DIR="$HOME/.claude/skills/voiceforge-config"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== VoiceForge Installer ==="
echo ""

# --- Prerequisites ---
if [[ "$(uname)" != "Darwin" ]]; then
    echo "WARNING: VoiceForge uses 'afplay' for audio playback (macOS only)."
    echo "On Linux, edit config to use paplay/pw-play instead."
    echo ""
fi

if ! command -v node &>/dev/null; then
    echo "ERROR: node is required but not found."
    exit 1
fi

# --- Detect fresh install vs update ---
if [[ -d "$INSTALL_DIR" ]]; then
    echo "Detected existing installation — updating..."
    IS_UPDATE=true
else
    echo "Fresh installation..."
    IS_UPDATE=false
fi

# --- Copy files ---
mkdir -p "$INSTALL_DIR/src"
cp "$REPO_DIR/src/"*.js "$INSTALL_DIR/src/"
cp "$REPO_DIR/package.json" "$INSTALL_DIR/"
cp "$REPO_DIR/voiceforge.sh" "$INSTALL_DIR/"
cp "$REPO_DIR/config.default.json" "$INSTALL_DIR/"
cp "$REPO_DIR/uninstall.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/voiceforge.sh"
chmod +x "$INSTALL_DIR/uninstall.sh"
chmod +x "$INSTALL_DIR/src/voiceforge.js"

echo "  Copied core files to $INSTALL_DIR"

# --- Config ---
if [[ "$IS_UPDATE" == true ]] && [[ -f "$INSTALL_DIR/config.json" ]]; then
    # Backfill any new keys from template into existing config
    node -e "
const fs = require('fs');
const defaults = JSON.parse(fs.readFileSync('$INSTALL_DIR/config.default.json', 'utf-8'));
const current = JSON.parse(fs.readFileSync('$INSTALL_DIR/config.json', 'utf-8'));
let changed = false;
for (const [k, v] of Object.entries(defaults)) {
    if (!(k in current)) {
        current[k] = v;
        changed = true;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) &&
               typeof current[k] === 'object' && current[k] !== null && !Array.isArray(current[k])) {
        for (const [sk, sv] of Object.entries(v)) {
            if (!(sk in current[k])) {
                current[k][sk] = sv;
                changed = true;
            }
        }
    }
}
if (changed) {
    fs.writeFileSync('$INSTALL_DIR/config.json', JSON.stringify(current, null, 2) + '\n');
    console.log('  Backfilled new config keys into existing config.json');
} else {
    console.log('  Existing config.json is up to date');
}
"
else
    cp "$REPO_DIR/config.default.json" "$INSTALL_DIR/config.json"
    echo "  Created config.json from template"
fi

# --- Cache directory ---
mkdir -p "$INSTALL_DIR/cache"
echo "  Created cache directory"

# --- Install skill ---
mkdir -p "$SKILL_DIR"
if [[ -d "$REPO_DIR/skills/voiceforge-config" ]]; then
    cp "$REPO_DIR/skills/voiceforge-config/SKILL.md" "$SKILL_DIR/"
    echo "  Installed skill to $SKILL_DIR"
fi

# --- Register hooks in settings.json ---
mkdir -p "$HOME/.claude"
if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo '{}' > "$SETTINGS_FILE"
fi

node -e "
const fs = require('fs');

const HOOK_CMD = '$INSTALL_DIR/voiceforge.sh';

const HOOKS = {
    'Stop':               { matcher: '', timeout: 10, async: true },
    'Notification':       { matcher: '', timeout: 10, async: true },
    'SessionEnd':         { matcher: '', timeout: 10, async: true },
    'UserPromptSubmit':   { matcher: '', timeout: 10, async: true },
    'PermissionRequest':  { matcher: '', timeout: 10, async: true },
    'PreCompact':         { matcher: '', timeout: 10, async: true },
};

const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));

if (!settings.hooks) settings.hooks = {};

for (const [event, cfg] of Object.entries(HOOKS)) {
    const hookEntry = {
        type: 'command',
        command: HOOK_CMD,
        timeout: cfg.timeout,
    };
    if (cfg.async) hookEntry.async = true;

    const matcherBlock = {
        matcher: cfg.matcher,
        hooks: [hookEntry],
    };

    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Remove any existing voiceforge hooks for this event
    settings.hooks[event] = settings.hooks[event].filter(
        block => !block.hooks || !block.hooks.some(
            h => (h.command || '').includes('voiceforge')
        )
    );

    settings.hooks[event].push(matcherBlock);
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
console.log('  Registered hooks for ' + Object.keys(HOOKS).length + ' events in settings.json');
"

# --- Check Chatterbox TTS ---
echo ""
if curl -s --connect-timeout 2 "http://localhost:8004/health" &>/dev/null || \
   curl -s --connect-timeout 2 "http://localhost:8004/" &>/dev/null; then
    echo "  Chatterbox TTS server detected at localhost:8004"
else
    echo "  WARNING: Chatterbox TTS server not detected at localhost:8004"
    echo "  VoiceForge will use fallback phrases but cannot generate speech."
    echo "  See README.md for Chatterbox setup instructions."
fi

# --- Done ---
echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $INSTALL_DIR/config.json"
echo "     - Set your OpenRouter API key"
echo "     - Set your voice WAV file name"
echo "  2. Start Chatterbox TTS server (see README.md)"
echo "  3. Start a new Claude Code session to hear VoiceForge!"
echo ""
echo "To uninstall: bash $INSTALL_DIR/uninstall.sh"
