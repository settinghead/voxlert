#!/usr/bin/env python3
"""SC Commander - StarCraft-style voice notifications for Claude Code.

Generates contextual 1-6 word phrases via OpenRouter LLM,
speaks them through a local Chatterbox TTS server.
"""

import sys
import json
import os
import hashlib
import subprocess
import random
import signal
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
CACHE_DIR = os.path.join(SCRIPT_DIR, "cache")
PID_FILE = os.path.join(SCRIPT_DIR, ".sound.pid")

# Hook event name -> internal category
EVENT_MAP = {
    "SessionStart": "session.start",
    "Stop": "task.complete",
    "UserPromptSubmit": "task.acknowledge",
    "PostToolUseFailure": "task.error",
    "PermissionRequest": "input.required",
    "PreCompact": "resource.limit",
    "Notification": "notification",
}

# Events where we call the LLM for a contextual phrase
CONTEXTUAL_EVENTS = {"Stop", "PostToolUseFailure"}

# Fallback phrases when LLM is unavailable or for non-contextual events
FALLBACK_PHRASES = {
    "session.start": [
        "All systems initialized",
        "Adjutant activated",
        "Command channel opened",
        "Reactor online systems nominal",
        "Operations ready and standing by",
        "All subsystems checked",
    ],
    "task.complete": [
        "Mission complete",
        "Objective secured",
        "All tasks fulfilled",
        "Operation completed",
        "Orders carried out",
        "Target achieved",
    ],
    "task.acknowledge": [
        "Orders received",
        "Request acknowledged",
        "Operations initiated",
        "Command confirmed",
        "Directive understood",
    ],
    "task.error": [
        "Error detected",
        "Systems malfunction reported",
        "Failure in subsystem detected",
        "Critical error encountered",
        "Anomaly detected",
        "Operation failed",
    ],
    "input.required": [
        "Authorization required",
        "Input needed",
        "Clearance requested",
        "Decision awaited",
        "Confirmation required",
    ],
    "resource.limit": [
        "Memory capacity critical",
        "Resources nearly exhausted",
        "Buffer limit approached",
        "Context capacity strained",
        "Power reserves depleted",
    ],
    "notification": [
        "Alert received",
        "Status change detected",
        "Notification logged",
    ],
}

SYSTEM_PROMPT = (
    "You are a StarCraft Terran adjutant (military AI). "
    "Respond with ONLY 2-8 words as a terse military status report. "
    "The phrase MUST end with a past participle or adjective (e.g. complete, deployed, fixed, detected, adjusted, built, failed, nominal, operational, required). "
    "Before the final word, state WHAT was done AND WHY it exists — the purpose or goal the item serves. "
    "Use patterns like 'purpose-noun item-noun adjective' or 'item for purpose adjective'. "
    "Analyze the context to infer the deeper reason each task or component exists. "
    "Be authoritative and robotic. No punctuation. No quotes. No explanation. "
    "Do NOT include the project name — it will be prepended automatically. "
    "Examples: "
    "Authorization bypass for session security patched. "
    "Database pooling for improved performance refactored. "
    "Reliability test suite confirmed."
    "Memory leak in cache layer fixed",
    "Rate limiter for abuse prevention deployed, "
)


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"enabled": True}


def extract_context(event_data):
    """Extract relevant context from the hook event for LLM phrase generation."""
    event = event_data.get("hook_event_name", "")

    if event == "Stop":
        msg = event_data.get("last_assistant_message", "")
        if msg:
            return f"Coding task completed. Assistant's summary: {msg[:300]}"
        return None

    if event == "PostToolUseFailure":
        tool = event_data.get("tool_name", "unknown")
        error = event_data.get("error", "unknown error")
        tool_input = event_data.get("tool_input", {})
        cmd = ""
        if isinstance(tool_input, dict):
            cmd = tool_input.get("command", tool_input.get("description", ""))
        return f"Tool '{tool}' failed. Command: {cmd[:100]}. Error: {error[:200]}"

    return None


def generate_phrase_llm(context, config):
    """Call OpenRouter to generate a contextual 1-3 word phrase."""
    api_key = config.get("openrouter_api_key", "")
    if not api_key:
        return None

    model = config.get("openrouter_model", "liquid/lfm-2-24b-a2b")

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": context},
        ],
        "max_tokens": 30,
        "temperature": 0.9,
    }).encode()

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        resp = urllib.request.urlopen(req, timeout=5)
        result = json.loads(resp.read())
        phrase = result["choices"][0]["message"]["content"].strip()
        # Clean up: remove quotes, punctuation, limit to 6 words
        phrase = phrase.strip("\"'.,!;:").strip()
        words = phrase.split()[:8]
        return " ".join(words) if words else None
    except Exception:
        return None


def kill_previous_sound():
    """Kill any currently playing sound."""
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError, OSError):
        pass


def speak_phrase(phrase, config):
    """Send phrase to Chatterbox TTS server and play the audio."""
    os.makedirs(CACHE_DIR, exist_ok=True)

    cache_key = hashlib.md5(phrase.lower().encode()).hexdigest()
    cache_path = os.path.join(CACHE_DIR, f"{cache_key}.wav")

    # Generate audio if not cached
    if not os.path.exists(cache_path):
        chatterbox_url = config.get("chatterbox_url", "http://localhost:8004")
        endpoint = f"{chatterbox_url}/v1/audio/speech"

        payload = json.dumps({
            "input": phrase,
            "voice": config.get("voice", "default.wav"),
            "model": "chatterbox-turbo",
            "response_format": "wav",
        }).encode()

        req = urllib.request.Request(
            endpoint,
            data=payload,
            headers={"Content-Type": "application/json"},
        )

        try:
            resp = urllib.request.urlopen(req, timeout=8)
            with open(cache_path, "wb") as f:
                f.write(resp.read())
        except Exception:
            # Chatterbox server not available - fail silently
            return

    # Kill previous sound and play new one
    kill_previous_sound()
    volume = str(config.get("volume", 0.5))
    proc = subprocess.Popen(
        ["afplay", "-v", volume, cache_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(proc.pid))
    except OSError:
        pass


def main():
    # Read event data from stdin
    try:
        event_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception):
        return

    config = load_config()
    if not config.get("enabled", True):
        return

    event_name = event_data.get("hook_event_name", "")
    category = EVENT_MAP.get(event_name)
    if not category:
        return

    # Check if category is enabled
    categories = config.get("categories", {})
    if not categories.get(category, True):
        return

    # Extract project name from cwd
    cwd = event_data.get("cwd", "")
    project_name = os.path.basename(cwd) if cwd else ""

    # For contextual events, try LLM phrase generation
    phrase = None
    if event_name in CONTEXTUAL_EVENTS:
        context = extract_context(event_data)
        if context:
            phrase = generate_phrase_llm(context, config)

    # Fall back to predefined phrases
    if not phrase:
        phrases = FALLBACK_PHRASES.get(category, ["Standing by"])
        phrase = random.choice(phrases)

    # Prepend project name as prefix
    if project_name:
        phrase = f"{project_name}: {phrase}"

    speak_phrase(phrase, config)


if __name__ == "__main__":
    main()
