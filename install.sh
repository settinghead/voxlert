#!/usr/bin/env bash
set -euo pipefail

# SC Commander Installer
# Installs SC Commander hooks into Claude Code

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.claude/hooks/sc-commander"
SKILL_DIR="$HOME/.claude/skills/sc-commander-config"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== SC Commander Installer ==="
echo ""

# --- Prerequisites ---
if [[ "$(uname)" != "Darwin" ]]; then
    echo "WARNING: SC Commander uses 'afplay' for audio playback (macOS only)."
    echo "On Linux, edit config to use paplay/pw-play instead."
    echo ""
fi

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 is required but not found."
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
mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/sc-commander.py" "$INSTALL_DIR/"
cp "$REPO_DIR/sc-commander.sh" "$INSTALL_DIR/"
cp "$REPO_DIR/config.default.json" "$INSTALL_DIR/"
cp "$REPO_DIR/uninstall.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/sc-commander.sh"
chmod +x "$INSTALL_DIR/uninstall.sh"

echo "  Copied core files to $INSTALL_DIR"

# --- Config ---
if [[ "$IS_UPDATE" == true ]] && [[ -f "$INSTALL_DIR/config.json" ]]; then
    # Backfill any new keys from template into existing config
    python3 -c "
import json, sys
with open('$INSTALL_DIR/config.default.json') as f:
    defaults = json.load(f)
with open('$INSTALL_DIR/config.json') as f:
    current = json.load(f)
changed = False
for k, v in defaults.items():
    if k not in current:
        current[k] = v
        changed = True
    elif isinstance(v, dict) and isinstance(current.get(k), dict):
        for sk, sv in v.items():
            if sk not in current[k]:
                current[k][sk] = sv
                changed = True
if changed:
    with open('$INSTALL_DIR/config.json', 'w') as f:
        json.dump(current, f, indent=2)
        f.write('\n')
    print('  Backfilled new config keys into existing config.json')
else:
    print('  Existing config.json is up to date')
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
if [[ -d "$REPO_DIR/skills/sc-commander-config" ]]; then
    cp "$REPO_DIR/skills/sc-commander-config/SKILL.md" "$SKILL_DIR/"
    echo "  Installed skill to $SKILL_DIR"
fi

# --- Register hooks in settings.json ---
mkdir -p "$HOME/.claude"
if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo '{}' > "$SETTINGS_FILE"
fi

python3 -c "
import json, sys

HOOK_CMD = '$INSTALL_DIR/sc-commander.sh'

# Define all hook events and their config
HOOKS = {
    'SessionStart':       {'matcher': '', 'timeout': 10, 'async': False},
    'Stop':               {'matcher': '', 'timeout': 10, 'async': True},
    'Notification':       {'matcher': '', 'timeout': 10, 'async': True},
    'SessionEnd':         {'matcher': '', 'timeout': 10, 'async': True},
    'SubagentStart':      {'matcher': '', 'timeout': 10, 'async': True},
    'UserPromptSubmit':   {'matcher': '', 'timeout': 10, 'async': True},
    'PermissionRequest':  {'matcher': '', 'timeout': 10, 'async': True},
    'PostToolUseFailure': {'matcher': 'Bash', 'timeout': 10, 'async': True},
    'PreCompact':         {'matcher': '', 'timeout': 10, 'async': True},
}

with open('$SETTINGS_FILE') as f:
    settings = json.load(f)

if 'hooks' not in settings:
    settings['hooks'] = {}

for event, cfg in HOOKS.items():
    hook_entry = {
        'type': 'command',
        'command': HOOK_CMD,
        'timeout': cfg['timeout'],
    }
    if cfg['async']:
        hook_entry['async'] = True

    matcher_block = {
        'matcher': cfg['matcher'],
        'hooks': [hook_entry],
    }

    if event not in settings['hooks']:
        settings['hooks'][event] = []

    # Remove any existing sc-commander hooks for this event
    settings['hooks'][event] = [
        block for block in settings['hooks'][event]
        if not any(
            h.get('command', '').endswith('sc-commander/sc-commander.sh')
            or 'sc-commander' in h.get('command', '')
            for h in block.get('hooks', [])
        )
    ]

    # Add our hook
    settings['hooks'][event].append(matcher_block)

with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('  Registered hooks for', len(HOOKS), 'events in settings.json')
"

# --- Check Chatterbox TTS ---
echo ""
if curl -s --connect-timeout 2 "http://localhost:8004/health" &>/dev/null || \
   curl -s --connect-timeout 2 "http://localhost:8004/" &>/dev/null; then
    echo "  Chatterbox TTS server detected at localhost:8004"
else
    echo "  WARNING: Chatterbox TTS server not detected at localhost:8004"
    echo "  SC Commander will use fallback phrases but cannot generate speech."
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
echo "  3. Start a new Claude Code session to hear SC Commander!"
echo ""
echo "To uninstall: bash $INSTALL_DIR/uninstall.sh"
