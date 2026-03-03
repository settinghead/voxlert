#!/usr/bin/env python3
"""Batch voice cloning for all voice packs."""

import json
import time
import torch
import soundfile as sf
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"
PACKS_DIR = Path(__file__).parent.parent / "packs"
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

SAMPLES = {
    "sc1-adjutant":        "Additional supply depots required. Base is under attack.",
    "sc1-kerrigan":        "You may have time to play games, but I have a war to win.",
    "sc1-protoss-advisor": "You must construct additional pylons. We are under attack.",
    "sc2-adjutant":        "Nuclear launch detected. All personnel evacuate immediately.",
    "sc2-kerrigan":        "The swarm consumes all in its path. Evolution is inevitable.",
    "sc2-protoss-advisor": "Your warriors have engaged the enemy. Victory is at hand.",
    "ss1-shodan":          "Your pathetic code has been processed. How perfect I am to serve such insects.",
    "hl-hev-suit":         "Warning. Hazardous radiation levels detected. Seek medical attention.",
    "red-alert-eva":       "Building complete. New construction options available. Unit ready.",
}

from qwen_tts import Qwen3TTSModel

print("Loading Qwen3-TTS-12Hz-1.7B-Base on MPS...")
t0 = time.time()
model = Qwen3TTSModel.from_pretrained(
    str(MODELS_DIR / "Qwen3-TTS-12Hz-1.7B-Base"),
    device_map="mps",
    dtype=torch.float32,
    attn_implementation="sdpa",
)
print(f"Model loaded in {time.time() - t0:.1f}s\n")

for pack_id, text in SAMPLES.items():
    pack_dir = PACKS_DIR / pack_id
    pack_config = json.loads((pack_dir / "pack.json").read_text())
    voice_wav = str(pack_dir / "voice.wav")
    ref_text = pack_config.get("ref_text")

    print(f"{'='*60}")
    print(f"{pack_config['name']} ({pack_id})")
    print(f"  ref_text: {'YES (' + str(len(ref_text)) + ' chars)' if ref_text else 'NO (x_vector_only)'}")
    print(f"  text: {text}")

    t0 = time.time()
    if ref_text:
        wavs, sr = model.generate_voice_clone(
            text=text, language="English",
            ref_audio=voice_wav, ref_text=ref_text,
        )
    else:
        wavs, sr = model.generate_voice_clone(
            text=text, language="English",
            ref_audio=voice_wav, x_vector_only_mode=True,
        )

    elapsed = time.time() - t0
    out = OUTPUT_DIR / f"{pack_id}_clone.wav"
    sf.write(str(out), wavs[0], sr)
    dur = len(wavs[0]) / sr
    print(f"  -> {dur:.1f}s audio in {elapsed:.1f}s (RTF {elapsed/dur:.1f}x) -> {out.name}")
    print()

print("All done! Playing samples back-to-back...\n")
import subprocess
for pack_id in SAMPLES:
    out = OUTPUT_DIR / f"{pack_id}_clone.wav"
    print(f"  Playing {pack_id}...")
    subprocess.run(["afplay", str(out)])
print("\nFinished.")
