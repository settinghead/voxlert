#!/usr/bin/env python3
"""
Qwen3-TTS voice cloning experiment using voiceforge voice packs.
Runs on Apple Silicon via MPS (Metal Performance Shaders).
Uses ref_text from pack.json for proper voice cloning.
"""

import json
import sys
import time
import torch
import soundfile as sf
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"
PACKS_DIR = Path(__file__).parent.parent / "packs"
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

# Pick a voice pack to clone
PACK = sys.argv[1] if len(sys.argv) > 1 else "sc2-kerrigan"
VOICE_WAV = PACKS_DIR / PACK / "voice.wav"
PACK_JSON = PACKS_DIR / PACK / "pack.json"

# Text to synthesize in the cloned voice
TEXT = sys.argv[2] if len(sys.argv) > 2 else "Task deployment sequence initiated. All systems nominal."

# Load pack config for ref_text
pack_config = json.loads(PACK_JSON.read_text())
ref_text = pack_config.get("ref_text")

print(f"Voice pack: {PACK} ({pack_config['name']})")
print(f"Reference audio: {VOICE_WAV}")
print(f"Ref transcript: {ref_text[:80]}..." if ref_text and len(ref_text) > 80 else f"Ref transcript: {ref_text}")
print(f"Text to synthesize: {TEXT}")
print(f"Device: MPS (Apple Silicon)")
print()

# Verify files exist
if not VOICE_WAV.exists():
    print(f"ERROR: Voice file not found: {VOICE_WAV}")
    sys.exit(1)

model_path = MODELS_DIR / "Qwen3-TTS-12Hz-1.7B-Base"
if not model_path.exists():
    print(f"ERROR: Model not found: {model_path}")
    sys.exit(1)

# Show reference audio info
ref_info = sf.info(str(VOICE_WAV))
print(f"Reference audio: {ref_info.duration:.1f}s, {ref_info.samplerate}Hz, {ref_info.channels}ch")

# Load model on MPS with float32 (required for voice clone on MPS)
print("\nLoading Qwen3-TTS-12Hz-1.7B-Base model on MPS...")
t0 = time.time()

from qwen_tts import Qwen3TTSModel

model = Qwen3TTSModel.from_pretrained(
    str(model_path),
    device_map="mps",
    dtype=torch.float32,
    attn_implementation="sdpa",
)

print(f"Model loaded in {time.time() - t0:.1f}s")

# Generate with full voice cloning (ref_text provided)
if ref_text:
    print(f"\nGenerating speech (full voice clone with transcript)...")
    t0 = time.time()

    wavs, sr = model.generate_voice_clone(
        text=TEXT,
        language="English",
        ref_audio=str(VOICE_WAV),
        ref_text=ref_text,
    )
else:
    print(f"\nNo ref_text found, falling back to x_vector_only_mode...")
    t0 = time.time()

    wavs, sr = model.generate_voice_clone(
        text=TEXT,
        language="English",
        ref_audio=str(VOICE_WAV),
        x_vector_only_mode=True,
    )

elapsed = time.time() - t0
output_path = OUTPUT_DIR / f"{PACK}_clone.wav"
sf.write(str(output_path), wavs[0], sr)

duration = len(wavs[0]) / sr
print(f"Generated {duration:.1f}s of audio in {elapsed:.1f}s (RTF: {elapsed/duration:.2f}x)")
print(f"Output saved: {output_path}")

# Play it
print("\nPlaying output...")
import subprocess
subprocess.run(["afplay", str(output_path)])
print("Done!")
