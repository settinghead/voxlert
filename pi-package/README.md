# pi-voxlert

**SHODAN, the StarCraft Adjutant, and GLaDOS narrate your pi coding sessions.**

Voice notifications for [pi](https://github.com/badlogic/pi) powered by [Voxlert](https://github.com/settinghead/voxlert). When your agent finishes a task or hits an error, you hear a contextual phrase in a game character's voice — instead of silence or a generic chime.

> "Awaiting further orders, Commander. Build process complete."

## Install

```bash
pi install npm:@settinghead/pi-voxlert
```

That's it. On first session, the extension detects that the Voxlert CLI is missing and offers to install + configure it automatically:

- Installs `@settinghead/voxlert` globally
- Downloads default voice packs (SHODAN, Adjutant, Kerrigan, etc.)
- Auto-detects your TTS backend (Qwen3-TTS on Apple Silicon, Chatterbox on CUDA)

You can also trigger setup manually anytime with `/voxlert setup`, or run `voxlert setup` in a terminal for full interactive configuration.

## What it does

| pi event | Voxlert action |
|----------|---------------|
| **Agent finishes** (`agent_end`) | Speaks a contextual in-character phrase |
| **Tool error** (`tool_result` with error) | Announces the error in character |

Phrases are generated per-event by an LLM, so you hear things like *"Pathetic authentication corrected"* (SHODAN) or *"Warning, Commander. Test suite failure detected"* (Adjutant) — not canned sounds.

## Commands

| Command | Description |
|---------|-------------|
| `/voxlert setup` | Install CLI + configure with defaults |
| `/voxlert test` | Fire a test voice notification |
| `/voxlert status` | Check if Voxlert CLI is available |
| `/voxlert` | Show help |

The LLM can also call the `voxlert_speak` tool to say something aloud on demand.

## Configuration

All voice pack, TTS backend, and LLM settings are managed through the Voxlert CLI:

```bash
voxlert config           # interactive configuration
voxlert packs            # list available voice packs
voxlert test "Hello"     # test your setup
```

Supports local TTS (Qwen3-TTS on Apple Silicon, Chatterbox on CUDA) and multiple LLM backends (OpenRouter, OpenAI, Anthropic, Gemini).

## Requirements

- [pi](https://github.com/badlogic/pi) coding agent
- [Voxlert CLI](https://github.com/settinghead/voxlert) installed and configured (`npm install -g @settinghead/voxlert && voxlert setup`)
- A TTS backend running (or Voxlert falls back to text notifications)

## Links

- [Voxlert repo](https://github.com/settinghead/voxlert)
- [Demo video](https://youtu.be/5xFXGijwJuk)
- [Available voice packs](https://github.com/settinghead/voxlert#voice-packs)
