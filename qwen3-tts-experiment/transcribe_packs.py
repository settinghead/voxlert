#!/usr/bin/env python3
"""Transcribe all voice pack WAV files using Whisper and add ref_text to pack.json."""

import json
import whisper
from pathlib import Path

PACKS_DIR = Path(__file__).parent.parent / "packs"

print("Loading Whisper model (base.en)...")
model = whisper.load_model("base.en")

for pack_dir in sorted(PACKS_DIR.iterdir()):
    pack_json = pack_dir / "pack.json"
    voice_wav = pack_dir / "voice.wav"

    if not pack_json.exists() or not voice_wav.exists():
        continue

    pack = json.loads(pack_json.read_text())
    print(f"\n{'='*60}")
    print(f"Pack: {pack['name']} ({pack_dir.name})")
    print(f"Audio: {voice_wav}")

    result = model.transcribe(str(voice_wav), language="en")
    transcript = result["text"].strip()

    print(f"Transcript: {transcript}")

    pack["ref_text"] = transcript
    pack_json.write_text(json.dumps(pack, indent=2) + "\n")
    print(f"Saved to pack.json")

print(f"\n{'='*60}")
print("All packs transcribed!")
