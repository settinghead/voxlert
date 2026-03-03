#!/usr/bin/env python3
"""Fix sentence spacing in voice pack WAV files.

Transcribes each voice.wav with word-level timestamps using Whisper,
detects sentence boundaries where gaps are too short, and inserts
silence to reach a target gap duration. Originals are backed up
to voice.orig.wav.
"""

import shutil
import whisper
from pathlib import Path
from pydub import AudioSegment

PACKS_DIR = Path(__file__).parent.parent / "packs"
MIN_GAP = 0.7   # seconds — gaps shorter than this at sentence boundaries get padded
TARGET_GAP = 1.0 # seconds — pad to this duration
SENTENCE_ENDINGS = {'.', '?', '!'}


def is_sentence_end(word_text):
    """Check if a word ends with sentence-ending punctuation."""
    stripped = word_text.rstrip()
    return stripped and stripped[-1] in SENTENCE_ENDINGS


def find_short_gaps(words):
    """Find sentence boundaries where the gap is shorter than MIN_GAP.

    Returns list of (insert_time_ms, silence_to_add_ms) tuples,
    sorted by insert_time descending so we can splice back-to-front.
    """
    gaps = []
    for i in range(len(words) - 1):
        current = words[i]
        nxt = words[i + 1]
        if not is_sentence_end(current["word"]):
            continue
        gap = nxt["start"] - current["end"]
        if gap < MIN_GAP:
            pad = TARGET_GAP - gap
            insert_at_ms = int(current["end"] * 1000)
            pad_ms = int(pad * 1000)
            gaps.append((insert_at_ms, pad_ms, current["word"], gap))
    # Sort descending by insert position so splicing doesn't shift later offsets
    gaps.sort(key=lambda g: g[0], reverse=True)
    return gaps


def process_pack(pack_dir, model):
    """Process a single voice pack directory."""
    voice_wav = pack_dir / "voice.wav"
    if not voice_wav.exists():
        return

    name = pack_dir.name
    print(f"\n{'='*60}")
    print(f"Pack: {name}")

    # Transcribe with word timestamps
    result = model.transcribe(str(voice_wav), language="en", word_timestamps=True)

    # Collect all words across segments
    words = []
    for seg in result["segments"]:
        for w in seg["words"]:
            words.append(w)

    if not words:
        print("  No words detected, skipping")
        return

    print(f"  Words: {len(words)}")

    # Find short gaps at sentence boundaries
    gaps = find_short_gaps(words)
    if not gaps:
        print("  No short sentence gaps found — audio spacing is fine")
        return

    print(f"  Sentence boundaries with short gaps: {len(gaps)}")
    for insert_ms, pad_ms, word, original_gap in gaps:
        print(f"    After \"{word.strip()}\" at {insert_ms}ms: "
              f"gap={original_gap:.3f}s -> adding {pad_ms}ms silence")

    # Load audio
    audio = AudioSegment.from_wav(str(voice_wav))
    original_duration = len(audio)

    # Splice in absolute silence back-to-front
    # Create silence matching the source audio's parameters (sample rate, channels, bit depth)
    for insert_ms, pad_ms, _, _ in gaps:
        silence = AudioSegment.silent(
            duration=pad_ms,
            frame_rate=audio.frame_rate,
        ).set_channels(audio.channels).set_sample_width(audio.sample_width)
        audio = audio[:insert_ms] + silence + audio[insert_ms:]

    new_duration = len(audio)
    added = new_duration - original_duration

    # Backup original and write new file
    backup = pack_dir / "voice.orig.wav"
    if not backup.exists():
        shutil.copy2(voice_wav, backup)
        print(f"  Backed up original to voice.orig.wav")
    else:
        print(f"  Backup voice.orig.wav already exists, preserving it")

    audio.export(str(voice_wav), format="wav")
    print(f"  Duration: {original_duration}ms -> {new_duration}ms (+{added}ms)")


def main():
    print("Loading Whisper model (medium.en)...")
    model = whisper.load_model("medium.en")

    pack_dirs = sorted(p for p in PACKS_DIR.iterdir() if p.is_dir())
    print(f"Found {len(pack_dirs)} packs")

    for pack_dir in pack_dirs:
        process_pack(pack_dir, model)

    print(f"\n{'='*60}")
    print("Done! All packs processed.")


if __name__ == "__main__":
    main()
