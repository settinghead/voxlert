# Chatterbox TTS (VoiceForge TTS backend)

[Chatterbox TTS](https://github.com/resemble-ai/chatterbox) runs as a local API server for speech synthesis. VoiceForge sends phrases to it and plays the returned audio.

## Installation

### 1. Clone and set up Chatterbox

```bash
git clone https://github.com/resemble-ai/chatterbox.git
cd chatterbox
python3 -m venv venv
source venv/bin/activate
pip install -e .
pip install fastapi uvicorn
```

### 2. Run the server

```bash
python -m chatterbox.server --port 8004
```

### 3. Point VoiceForge at it

```bash
voiceforge config set tts_backend chatterbox
```

VoiceForge expects Chatterbox at `http://localhost:8004` by default. Change the URL with:

```bash
voiceforge config set chatterbox_url http://localhost:8004
```

## Auto-start (optional, macOS)

Create `~/Library/LaunchAgents/com.chatterbox.tts.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chatterbox.tts</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/chatterbox/venv/bin/python</string>
        <string>-m</string>
        <string>chatterbox.server</string>
        <string>--port</string>
        <string>8004</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/chatterbox</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/chatterbox.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/chatterbox.err</string>
</dict>
</plist>
```

Replace `/path/to/chatterbox` with your clone path. Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.chatterbox.tts.plist
```

## Requirements

- **Python 3.10+**
- **GPU**: CUDA or MPS (Apple Silicon) for best performance
