---
name: voxlert-config
description: >
  View and edit Voxlert configuration (voice notifications, alerts, announcements).
  Trigger when the user asks to change, set, or customize the voice, sound, announcement,
  alert, or notification style — globally or for a specific project/folder.
  Examples: "change voice to adjutant", "use starcraft voice for this project",
  "set alert sound to kerrigan", "make notifications use EVA voice",
  "change the voice in this folder", "switch to SHODAN for alerts".
user_invocable: true
---

# Voxlert Configuration

Voxlert generates character voice notifications for Claude Code, Cursor, Codex, and OpenClaw.

## Use the CLI for everything

Always use `voxlert` CLI commands to read state and apply changes. Do not guess values or hardcode pack names.

### Read state

```bash
voxlert config show           # full current config
voxlert config path           # where the global config file lives
voxlert pack list             # all available packs with IDs and descriptions
voxlert pack show             # details of the currently active pack
```

### Apply changes (global)

```bash
voxlert pack use <pack-id>              # switch voice pack
voxlert volume <0-100>                  # set volume
voxlert config set enabled false        # disable voxlert
voxlert config set categories.task.complete false   # disable a category
voxlert config set <key> <value>        # set any config field (dot notation supported)
```

### Apply changes (per-project)

`voxlert config local set` writes to `.voxlert.json` in the current directory, scoping the change to that project only. The same dot notation is supported.

```bash
voxlert config local set active_pack sc1-adjutant
voxlert config local set volume 0.6
voxlert config local set categories.task.complete false
voxlert config local           # show current local config
voxlert config local path      # print path to .voxlert.json
```

Only whitelisted fields are honoured per-project: `enabled`, `active_pack`, `volume`, `categories`, `prefix`, `tts_backend`, `qwen_tts_url`, `overlay`, `overlay_dismiss`, `overlay_style`, `collect_llm_data`, `max_cache_entries`, `logging`, `error_log`. Fields like `openrouter_api_key` and `chatterbox_url` are global-only.

## Instructions

### Step 1 — Determine scope

- **Project scope**: user is in a project folder, or says "for this project / in this folder / here" → create/update `.voxlert.json` in cwd.
- **Global scope**: user says "everywhere / my default" or there is no project context → use CLI commands.

### Step 2 — Look up current state and options via CLI

Always run `voxlert config show` first to see what is currently set. If the user's intent involves packs, run `voxlert pack list` to get the actual pack IDs — never guess them.

### Step 3 — Match the user's intent to the right command

| User says | CLI command |
|---|---|
**Global scope:**

| User says | CLI command |
|---|---|
| "change voice / character / announcement to X" | `voxlert pack list` → find ID → `voxlert pack use <id>` |
| "set volume / louder / quieter" | `voxlert volume <0-100>` |
| "disable / mute / silence voxlert" | `voxlert config set enabled false` |
| "re-enable / unmute" | `voxlert config set enabled true` |
| "disable a category" | `voxlert config set categories.<name> false` |
| "enable a category" | `voxlert config set categories.<name> true` |
| "set any other field" | `voxlert config set <key> <value>` |

**Project scope** — use `voxlert config local set` which writes/merges into `.voxlert.json` in cwd:

| User says | CLI command |
|---|---|
| "change voice for this project" | `voxlert pack list` → find ID → `voxlert config local set active_pack <id>` |
| "set volume for this project" | `voxlert config local set volume <0-1>` |
| "disable voxlert for this repo" | `voxlert config local set enabled false` |
| "disable a category for this project" | `voxlert config local set categories.<name> false` |

### Step 4 — Confirm

Tell the user what changed and where. Changes take effect on the next hook event — no restart needed.

