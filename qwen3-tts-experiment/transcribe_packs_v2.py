#!/usr/bin/env python3
"""Transcribe all voice pack WAV files using Whisper medium.en for better accuracy."""

import json
import whisper
from pathlib import Path

PACKS_DIR = Path(__file__).parent.parent / "packs"

print("Loading Whisper model (medium.en)...")
model = whisper.load_model("medium.en")

for pack_dir in sorted(PACKS_DIR.iterdir()):
    pack_json = pack_dir / "pack.json"
    voice_wav = pack_dir / "voice.wav"

    if not pack_json.exists() or not voice_wav.exists():
        continue

    pack = json.loads(pack_json.read_text())
    print(f"\n{'='*60}")
    print(f"Pack: {pack['name']} ({pack_dir.name})")

    result = model.transcribe(str(voice_wav), language="en")
    transcript = result["text"].strip()

    print(f"Transcript ({len(transcript)} chars):")
    print(f"  {transcript[:120]}{'...' if len(transcript) > 120 else ''}")

    pack["ref_text"] = transcript
    pack_json.write_text(json.dumps(pack, indent=2) + "\n")

print(f"\n{'='*60}")
print("All packs transcribed with medium.en!")
