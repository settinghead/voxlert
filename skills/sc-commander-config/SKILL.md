---
name: sc-commander-config
description: View and edit SC Commander configuration (voice notifications)
user_invocable: true
---

# SC Commander Configuration

SC Commander generates StarCraft-style voice notifications for Claude Code hook events.

## Config File Location

`~/.claude/hooks/sc-commander/config.json`

## Configuration Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master on/off switch |
| `openrouter_api_key` | string | `""` | OpenRouter API key for LLM phrase generation |
| `openrouter_model` | string | `"google/gemini-2.0-flash-001"` | LLM model for generating contextual phrases |
| `chatterbox_url` | string | `"http://localhost:8004"` | Chatterbox TTS server URL |
| `voice` | string | `"default.wav"` | Voice reference WAV file name (in Chatterbox voices dir) |
| `volume` | number | `1.0` | Playback volume (0.0 to 1.0) |
| `categories` | object | see below | Per-category enable/disable |

### Categories

| Category | Hook Event | Default |
|---|---|---|
| `session.start` | SessionStart | enabled |
| `task.complete` | Stop | enabled |
| `task.acknowledge` | UserPromptSubmit | disabled |
| `task.error` | PostToolUseFailure | enabled |
| `input.required` | PermissionRequest | enabled |
| `resource.limit` | PreCompact | enabled |
| `notification` | Notification | enabled |

## Instructions

When the user asks to configure SC Commander:

1. **Read** the current config:
   ```
   Read ~/.claude/hooks/sc-commander/config.json
   ```

2. **Edit** values using the Edit tool on that file.

3. Changes take effect on the next hook event (no restart needed).

## Cache Management

To clear the TTS audio cache (e.g., after changing voice):

```bash
rm -f ~/.claude/hooks/sc-commander/cache/*.wav
```

This forces SC Commander to regenerate audio on next use.
