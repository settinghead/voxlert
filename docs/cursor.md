# Cursor Integration

VoiceForge speaks character voice notifications when using [Cursor](https://cursor.com) Agent (Cmd+K or Agent Chat). This page is a reference for Cursor-specific setup and troubleshooting.

## How It Works

Cursor runs hook scripts when certain agent events occur. VoiceForge registers a single command, `voiceforge cursor-hook`, which:

1. Receives Cursor’s JSON payload on stdin
2. Maps Cursor hook names (camelCase) to VoiceForge events (PascalCase)
3. Optionally reads the conversation transcript on **stop** to generate an in-character summary
4. Runs the same pipeline as Claude Code (LLM phrase or fallback → TTS → playback)
5. Returns `{}` on stdout so Cursor receives valid JSON

## Config Location

- **User-level (all workspaces):** `~/.cursor/hooks.json`
- **Project-level (single repo):** `<project-root>/.cursor/hooks.json`

VoiceForge’s setup wizard installs user-level hooks. To restrict VoiceForge to one project, copy the hook entries into that project’s `.cursor/hooks.json` instead.

## Events We Subscribe To

| Cursor Hook           | VoiceForge Event     | Category        |
|-----------------------|----------------------|-----------------|
| `sessionStart`        | SessionStart         | session.start   |
| `sessionEnd`          | SessionEnd           | session.end     |
| `stop`                | Stop                 | task.complete   |
| `postToolUseFailure`  | PostToolUseFailure   | task.error      |
| `preCompact`          | PreCompact           | resource.limit  |

Turn categories on or off in VoiceForge config (`voiceforge config set categories.<name> true|false` or `voiceforge setup`).

## Install

**During setup:**

```bash
voiceforge setup
```

When prompted **"Install Cursor hooks?"**, choose **Yes**.

**Manual install:** Ensure `~/.cursor/hooks.json` exists and includes:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "voiceforge cursor-hook", "timeout": 10 }],
    "sessionEnd": [{ "command": "voiceforge cursor-hook", "timeout": 10 }],
    "stop": [{ "command": "voiceforge cursor-hook", "timeout": 10 }],
    "postToolUseFailure": [{ "command": "voiceforge cursor-hook", "timeout": 10 }],
    "preCompact": [{ "command": "voiceforge cursor-hook", "timeout": 10 }]
  }
}
```

Restart Cursor after installing or editing hooks.

## Uninstall

Run the standard uninstaller; it removes VoiceForge entries from `~/.cursor/hooks.json` as well as Claude Code hooks:

```bash
bash ~/.claude/hooks/voiceforge/uninstall.sh
```

Or remove only Cursor hooks by editing `~/.cursor/hooks.json` and deleting the entries that call `voiceforge cursor-hook`.

## Configuration

VoiceForge uses the same config for Cursor as for Claude Code and OpenClaw:

- Config path: `voiceforge config path` (typically `~/.voiceforge/config.json` or install-dir `config.json`)
- Toggle categories, voice pack, volume, and LLM/TTS via `voiceforge config` or `voiceforge setup`

## Troubleshooting

- **No voice when agent stops / starts**
  - Confirm hooks are installed: open `~/.cursor/hooks.json` and check for `voiceforge cursor-hook` entries.
  - Restart Cursor after changing `hooks.json`.
  - In Cursor: **Settings → Hooks** (or the Hooks output channel) to see whether hooks ran and any errors.

- **`voiceforge cursor-hook` not found**
  - Install VoiceForge globally so the command is on PATH: `npm install -g @settinghead/voiceforge`, then run `voiceforge setup`.
  - Or use the full path to the script in `hooks.json`, e.g. `"/path/to/voiceforge/repo/node_modules/.bin/voiceforge" cursor-hook` (adjust for your install).

- **Test the adapter manually**
  - Echo a minimal Cursor payload and pipe to the CLI:
    ```bash
    echo '{"hook_event_name":"stop","workspace_roots":["/tmp"]}' | voiceforge cursor-hook
    ```
  - You should see `{}` on stdout and hear a fallback phrase (or an LLM phrase if transcript/context is available).

For full Cursor hook schema and options, see [Cursor Hooks documentation](https://cursor.com/docs/agent/hooks).
