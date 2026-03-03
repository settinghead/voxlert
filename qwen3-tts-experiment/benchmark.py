#!/usr/bin/env python3
"""Benchmark Qwen3-TTS voice cloning: generation time vs text length."""

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

# Model size from CLI arg: "1.7B" or "0.6B"
MODEL_SIZE = sys.argv[1] if len(sys.argv) > 1 else "1.7B"
MODEL_NAME = f"Qwen3-TTS-12Hz-{MODEL_SIZE}-Base"

# Test texts of varying lengths
TEXTS = [
    ("short",  "Base is under attack."),
    ("medium", "Nuclear launch detected. All personnel evacuate immediately."),
    ("long",   "Warning. Hazardous radiation levels detected. Atmospheric contaminant sensors activated. Seek medical attention immediately."),
    ("xlong",  "Attention all units. The primary objective has been compromised. Deploy secondary forces to sector seven. Reinforce defensive perimeter. Air support is inbound. Hold your positions and await further instructions from command."),
]

# Test with 3 distinct voice packs
PACKS = ["sc2-kerrigan", "hl-hev-suit", "red-alert-eva"]

from qwen_tts import Qwen3TTSModel

# Model loading
model_path = MODELS_DIR / MODEL_NAME
print(f"Loading {MODEL_NAME} on MPS...")
t_load = time.time()
model = Qwen3TTSModel.from_pretrained(
    str(model_path),
    device_map="mps",
    dtype=torch.float32,
    attn_implementation="sdpa",
)
load_time = time.time() - t_load
print(f"Model load time: {load_time:.1f}s\n")

# Build reusable prompts (measure prompt creation time too)
prompts = {}
for pack_id in PACKS:
    pack_dir = PACKS_DIR / pack_id
    pack_config = json.loads((pack_dir / "pack.json").read_text())
    ref_text = pack_config.get("ref_text", "")

    t0 = time.time()
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(pack_dir / "voice.wav"),
        ref_text=ref_text,
        x_vector_only_mode=False,
    )
    prompt_time = time.time() - t0
    prompts[pack_id] = prompt
    print(f"Prompt creation for {pack_id}: {prompt_time:.1f}s")

print()

# Header
print(f"{'Pack':<22} {'Label':<8} {'Chars':>5} {'Words':>5} {'AudioLen':>8} {'GenTime':>8} {'RTF':>6}")
print("-" * 75)

results = []
for pack_id in PACKS:
    for label, text in TEXTS:
        t0 = time.time()
        wavs, sr = model.generate_voice_clone(
            text=text,
            language="English",
            voice_clone_prompt=prompts[pack_id],
        )
        gen_time = time.time() - t0
        audio_len = len(wavs[0]) / sr

        out = OUTPUT_DIR / f"bench_{MODEL_SIZE}_{pack_id}_{label}.wav"
        sf.write(str(out), wavs[0], sr)

        char_count = len(text)
        word_count = len(text.split())
        rtf = gen_time / audio_len

        print(f"{pack_id:<22} {label:<8} {char_count:>5} {word_count:>5} {audio_len:>7.1f}s {gen_time:>7.1f}s {rtf:>5.1f}x")
        results.append((pack_id, label, char_count, word_count, audio_len, gen_time, rtf))

print("-" * 75)
avg_rtf = sum(r[6] for r in results) / len(results)
print(f"{'Average RTF':>63} {avg_rtf:>5.1f}x")
print(f"\nModel: {MODEL_NAME}")
print(f"Model load time: {load_time:.1f}s")
print(f"Total generations: {len(results)}")

# Play a couple
import subprocess
print("\nPlaying short vs xlong for sc2-kerrigan...")
for label in ["short", "xlong"]:
    f = OUTPUT_DIR / f"bench_{MODEL_SIZE}_sc2-kerrigan_{label}.wav"
    print(f"  {label}...")
    subprocess.run(["afplay", str(f)])
print("Done!")
