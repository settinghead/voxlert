# Creating Voice Packs

A voice pack gives VoiceForge a character personality and voice. This guide covers how to create your own.

## Directory Structure

Each pack lives in `packs/<pack-id>/`:

```
packs/my-character/
  pack.json     # Pack configuration
  voice.wav     # Voice reference sample for TTS cloning
```

The `<pack-id>` is a kebab-case identifier (e.g. `red-alert-eva`, `sc1-kerrigan`).

## pack.json Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name (e.g. "StarCraft 1 Kerrigan") |
| `voice` | string | yes | Voice reference WAV file, relative to pack dir |
| `echo` | boolean | no | Add echo/reverb effect to playback (default: `true`) |
| `tts_params` | object | no | Override TTS parameters (`exaggeration`, `cfg_weight`) |
| `audio_filter` | string | no | Custom ffmpeg audio filter chain |
| `post_process` | string | no | Shell command for post-processing audio (`$INPUT`, `$OUTPUT` placeholders) |
| `style` | string | no | Character personality prompt (see below) |
| `fallback_phrases` | object | no | Category-keyed phrases used when LLM is unavailable |

### Minimal Example

```json
{
  "name": "My Character",
  "voice": "voice.wav",
  "style": "You are a cheerful robot assistant. Upbeat and enthusiastic."
}
```

### Full Example

```json
{
  "name": "Red Alert EVA",
  "voice": "voice.wav",
  "echo": false,
  "tts_params": {
    "exaggeration": 0.75,
    "cfg_weight": 0.7
  },
  "style": "Terse military AI. Authoritative, robotic, precise. Use military and deployment vocabulary. Examples:\nConstruction complete\nUnit ready\nNew rally point established\nAllied forces detected",
  "fallback_phrases": {
    "task.complete": ["Construction complete", "Unit ready", "Mission accomplished"],
    "task.acknowledge": ["Acknowledged", "Affirmative", "Orders received"],
    "task.error": ["Operation failed", "Unit lost"],
    "input.required": ["Awaiting orders", "Select target"],
    "resource.limit": ["Insufficient funds", "Low power"],
    "session.end": ["Connection lost", "Signing off"],
    "notification": ["Warning", "Unit lost"]
  }
}
```

## How Format vs Style Works

VoiceForge separates **format** (structural rules) from **style** (character personality).

**Format** is defined in code (`src/formats.js`) and shared across all packs. It controls:
- Word count (2-8 words)
- Grammar (must end with past participle or adjective)
- Content rules (state what was done, no project name, no punctuation)

**Style** is defined per pack in `pack.json`. It controls:
- Character identity ("You are SHODAN...")
- Tone and demeanor ("cold, superior, dismissive")
- Vocabulary preferences ("prefer words like consumed, futile, terminated")
- Character-specific examples that demonstrate the voice

When generating a phrase, VoiceForge composes the final LLM system prompt as:

```
[style] + [format rules]
```

Packs with `style: null` use a default neutral style ("terse AI assistant").

## Writing a Good Style

A style prompt should be short and focused on personality. Don't repeat format rules — those are added automatically.

### Include

- **Tone**: How to speak (commanding, serene, contemptuous, etc.)
- **Vocabulary guidance**: Preferred words or themes
- **Examples**: 4-6 example phrases demonstrating the voice

### Avoid

- Character backstory or lore (keep it about the voice, not the character)
- Word count rules (handled by format)
- Grammar rules like "must end with past participle" (handled by format)
- "No punctuation / no quotes" (handled by format)
- "Do not include the project name" (handled by format)

### Example

```
Serene, reverent, measured. Ancient psionic oracle tone. Use psionic and Khala
vocabulary. Prefer words like restored, harmonized, purified, aligned,
transcendent, reclaimed. Examples:
Psionic task matrix completed
Khala's light restored
Ancient code harmonized
The path forward illuminated
```

## Fallback Phrases

When the LLM is unavailable (no API key, timeout, etc.), VoiceForge picks a random phrase from `fallback_phrases`. Categories (used by Claude Code, Cursor, and OpenClaw):

| Category | When |
|----------|------|
| `task.complete` | Agent finishes a task |
| `task.acknowledge` | User sends a prompt |
| `task.error` | A tool call fails |
| `input.required` | Agent needs approval |
| `resource.limit` | Context window nearing limit |
| `session.start` | New session begins |
| `session.end` | Session ends |
| `notification` | General notification |

If a pack doesn't define fallback phrases, global defaults are used.

## Voice Reference File

The `voice.wav` file is a short (5-15 second) WAV sample used by Chatterbox TTS to clone the character's voice. Use clean audio with minimal background noise.

**Note:** Do not commit copyrighted voice samples. Use your own recordings or freely licensed audio.

## Testing

Test your pack with the CLI:

```bash
# Switch to your pack
voiceforge pack use my-character

# Test the full pipeline (LLM -> TTS -> audio)
voiceforge test "Fixed a bug in the login form"

# View pack details
voiceforge pack show
```

## Backward Compatibility

Packs using the old `system_prompt` field (instead of `style`) still work. The `system_prompt` value is used as a raw style override. New packs should use `style`.
