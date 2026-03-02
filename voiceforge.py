#!/usr/bin/env python3
"""VoiceForge - Game character voice notifications for Claude Code.

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
import time
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
CACHE_DIR = os.path.join(SCRIPT_DIR, "cache")
COLLECT_DIR = os.path.join(SCRIPT_DIR, "llm_collect")
PID_FILE = os.path.join(SCRIPT_DIR, ".sound.pid")

# Hook event name -> internal category
EVENT_MAP = {
    "Stop": "task.complete",
    "UserPromptSubmit": "task.acknowledge",
    "PermissionRequest": "input.required",
    "PreCompact": "resource.limit",
    "Notification": "notification",
}

# Events where we call the LLM for a contextual phrase
CONTEXTUAL_EVENTS = {"Stop"}

# Fallback phrases when LLM is unavailable or for non-contextual events
FALLBACK_PHRASES = {
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
    "You are a terse AI assistant. "
    "Respond with ONLY 2-8 words as a brief status report. "
    "The phrase MUST end with a past participle or adjective (e.g. complete, deployed, fixed, detected, adjusted, built, failed, nominal, operational, required). "
    "Before the final word, state WHAT was done AND WHY it exists — the purpose or goal the item serves. "
    "Use patterns like 'purpose-noun item-noun adjective' or 'item for purpose adjective'. "
    "Analyze the context to infer the deeper reason each task or component exists. "
    "Be authoritative and robotic. No punctuation. No quotes. No explanation. "
    "Do NOT include the project name — it will be prepended automatically. "
    "Examples: "
    "\nAuthorization bypass for session security patched. "
    "\nDatabase pooling for improved performance refactored. "
    "\nReliability test suite confirmed. "
    "\nMemory leak in cache layer fixed. "
    "\nRate limiter for abuse prevention deployed."
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

    return None


def _save_llm_pair(messages, response_text, model, config):
    """Save an LLM prompt/response pair to disk for fine-tuning data collection."""
    if not config.get("collect_llm_data", False):
        return
    try:
        os.makedirs(COLLECT_DIR, exist_ok=True)
        record = {
            "timestamp": time.time(),
            "model": model,
            "messages": messages,
            "response": response_text,
        }
        filename = f"{int(time.time() * 1000)}.json"
        with open(os.path.join(COLLECT_DIR, filename), "w") as f:
            json.dump(record, f, indent=2)
    except Exception:
        pass


def generate_phrase_llm(context, config):
    """Call OpenRouter to generate a contextual 1-3 word phrase."""
    api_key = config.get("openrouter_api_key", "")
    if not api_key:
        return None

    model = config.get("openrouter_model", "qwen/qwen3.5-flash-02-23")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": context},
    ]

    payload = json.dumps({
        "model": model,
        "messages": messages,
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
        _save_llm_pair(messages, phrase, model, config)
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


def _save_pid(pid):
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(pid))
    except OSError:
        pass


def _echo_filter():
    """Return an ffplay/ffmpeg aecho filter string for sci-fi style reverb."""
    # Short multi-tap echo: two taps at 40ms and 75ms with moderate decay
    return "aecho=0.8:0.88:40|75:0.4|0.25"


def _play_cached(cache_path, volume):
    """Play a cached wav file, preferring ffplay (for echo) with afplay fallback."""
    kill_previous_sound()
    try:
        vol_pct = str(int(float(volume) * 100))
        proc = subprocess.Popen(
            ["ffplay", "-nodisp", "-autoexit", "-volume", vol_pct,
             "-af", _echo_filter(), cache_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        # ffplay not available — fall back to afplay (no echo)
        proc = subprocess.Popen(
            ["afplay", "-v", str(volume), cache_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    _save_pid(proc.pid)


def _stream_and_play(resp, cache_path, volume):
    """Stream TTS response to ffplay while caching to disk."""
    kill_previous_sound()
    vol_pct = str(int(float(volume) * 100))
    player = subprocess.Popen(
        ["ffplay", "-nodisp", "-autoexit", "-volume", vol_pct,
         "-af", _echo_filter(), "-i", "pipe:0"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _save_pid(player.pid)
    with open(cache_path, "wb") as cache_file:
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            cache_file.write(chunk)
            try:
                player.stdin.write(chunk)
            except BrokenPipeError:
                break
    player.stdin.close()


def speak_phrase(phrase, config):
    """Send phrase to Chatterbox TTS server and play the audio."""
    os.makedirs(CACHE_DIR, exist_ok=True)

    cache_key = hashlib.md5(phrase.lower().encode()).hexdigest()
    cache_path = os.path.join(CACHE_DIR, f"{cache_key}.wav")
    volume = config.get("volume", 0.5)

    # Cached: play immediately
    if os.path.exists(cache_path):
        _play_cached(cache_path, volume)
        return

    # Fetch from TTS server
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
    except Exception:
        return

    # Try streaming playback via ffplay (starts audio before full download)
    try:
        _stream_and_play(resp, cache_path, volume)
    except FileNotFoundError:
        # ffplay not available — fall back to full download + afplay
        with open(cache_path, "wb") as f:
            f.write(resp.read())
        _play_cached(cache_path, volume)


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
        phrase = f"{project_name}, {phrase}"

    speak_phrase(phrase, config)


if __name__ == "__main__":
    main()
