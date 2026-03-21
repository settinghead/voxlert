"""Qwen3-TTS FastAPI server for Voxlert — dual MLX / PyTorch backend.

Voices are uploaded via POST /voices (content-hashed, deduplicated) and
referenced by voice_id in the POST /tts endpoint.
"""

import os
import gc
import io
import json
import hashlib
import asyncio
import concurrent.futures
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

import cache

RUNTIME = os.environ.get("QWEN_TTS_RUNTIME", "mlx").lower()
VOICES_DIR = Path(os.environ.get(
    "QWEN_TTS_VOICES_DIR",
    str(Path(__file__).resolve().parent / "voices"),
))
MODELS_DIR = Path(__file__).resolve().parent / "models"
PORT = 8100
TTS_TIMEOUT = 60

app = FastAPI(title="Qwen3-TTS Server")

# Filled at startup
model = None
model_name = None
voice_meta: dict[str, dict] = {}           # MLX:     voice_id -> {ref_text}
voice_prompt_cache: dict[str, list] = {}    # PyTorch: voice_id -> VoiceClonePromptItem list

# MLX voice prompt cache: voice_id -> {speaker_embed, ref_codes, ref_text, audio}
# Pre-computed at registration time so that generation avoids redundant
# speaker-encoder and speech-tokenizer work on every cache-miss TTS call.
# The "audio" field is a minimal stub — the full waveform is not retained
# because the monkey-patched methods ignore their input.
_mlx_prompt_cache: dict[str, dict] = {}

# Single-thread executor — keeps all GPU work on ONE thread to respect
# Metal thread affinity (MLX) and MPS requirements (PyTorch).
_gpu_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="gpu",
)

# ---------------------------------------------------------------------------
# MLX backend
# ---------------------------------------------------------------------------

# Default: 1.7B-8bit for best voice quality (~2.9 GB: 2.25 GB backbone + 651 MB codec).
# Override with QWEN_TTS_MLX_MODEL for lower memory at reduced quality:
#   0.6B-4bit: ~1.63 GB (mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit)
#   0.6B-6bit: ~1.65 GB (mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit)
MLX_MODEL_ID = os.environ.get(
    "QWEN_TTS_MLX_MODEL",
    "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
)

# How much freed Metal memory the MLX allocator may hoard for reuse.
# Lower = tighter steady-state footprint; higher = fewer re-allocations.
# 0 disables the cache entirely.  Default: 256 MB.
_MLX_CACHE_LIMIT = int(os.environ.get("QWEN_TTS_MLX_CACHE_MB", "256")) * 1024 * 1024


def _load_mlx():
    global model, model_name
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model

    model_name = MLX_MODEL_ID.split("/")[-1]
    print(f"Loading MLX model {model_name} …")
    model = load_model(MLX_MODEL_ID)

    # Cap the Metal allocator's free-buffer cache so freed memory returns
    # to the OS instead of being held indefinitely for potential reuse.
    mx.set_cache_limit(_MLX_CACHE_LIMIT)

    active_mb = mx.get_active_memory() / 1024 / 1024
    print(f"MLX model loaded.  Active Metal memory: {active_mb:.0f} MB  "
          f"(cache limit: {_MLX_CACHE_LIMIT // 1024 // 1024} MB)")


def _precompute_voice_mlx(wav_path: str, ref_text: str) -> dict:
    """Extract and return voice-specific artifacts that are reused across
    every TTS call for the same voice.

    Returns dict with:
      speaker_embed: mx.array — x-vector from the speaker encoder
      ref_codes:     mx.array or None — speech tokenizer codes (ICL mode)
      ref_text:      str
      audio:         mx.array — minimal stub (monkey-patched methods ignore it)
    """
    import mlx.core as mx
    from mlx_audio.utils import load_audio

    audio = load_audio(wav_path, sample_rate=model.sample_rate)

    # Speaker embedding (x-vector)
    speaker_embed = None
    if getattr(model, "speaker_encoder", None) is not None:
        speaker_embed = model.extract_speaker_embedding(audio)
        mx.eval(speaker_embed)

    # Reference codec codes (for ICL voice cloning)
    ref_codes = None
    st = getattr(model, "speech_tokenizer", None)
    if st is not None and getattr(st, "has_encoder", False):
        audio_enc = audio[None, None, :] if audio.ndim == 1 else audio[None, :]
        ref_codes = st.encode(audio_enc)
        mx.eval(ref_codes)

    # Replace full waveform with a tiny stub.  The generate() pipeline
    # requires ref_audio to be a non-None mx.array with ndim >= 1, but
    # both extract_speaker_embedding and speech_tokenizer.encode are
    # monkey-patched to return cached values — so the stub is never
    # actually processed.  This avoids retaining ~0.5-1 MB per voice.
    audio_stub = mx.zeros((model.sample_rate,))

    # Release the full waveform from Metal memory
    del audio
    mx.clear_cache()
    return {
        "speaker_embed": speaker_embed,
        "ref_codes": ref_codes,
        "ref_text": ref_text,
        "audio": audio_stub,
    }


def _prompt_cache_dir(voice_dir: Path) -> Path:
    """Return the model-specific prompt cache directory for a voice.

    Layout: voices/<voice_id>/prompts/<model_key>/
    Each model gets its own namespace so switching models (e.g. 0.6B <-> 1.7B)
    never requires recomputation — both caches coexist on disk.
    """
    model_key = hashlib.sha256(MLX_MODEL_ID.encode()).hexdigest()[:12]
    return voice_dir / "prompts" / model_key


def _save_voice_cache_mlx(voice_dir: Path, prompt: dict):
    """Persist pre-computed voice embeddings as .npy so they survive restarts."""
    cache_dir = _prompt_cache_dir(voice_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    if prompt["speaker_embed"] is not None:
        np.save(str(cache_dir / "speaker_embed.npy"), np.array(prompt["speaker_embed"]))
    if prompt["ref_codes"] is not None:
        np.save(str(cache_dir / "ref_codes.npy"), np.array(prompt["ref_codes"]))


def _load_voice_cache_mlx(voice_dir: Path, ref_text: str) -> dict | None:
    """Load persisted voice embeddings from disk for the current model.

    Returns None if no cache exists for this model — a different model's
    cache is simply ignored, not deleted."""
    import mlx.core as mx

    cache_dir = _prompt_cache_dir(voice_dir)
    embed_path = cache_dir / "speaker_embed.npy"
    if not embed_path.exists():
        return None

    codes_path = cache_dir / "ref_codes.npy"
    speaker_embed = mx.array(np.load(str(embed_path)))
    ref_codes = mx.array(np.load(str(codes_path))) if codes_path.exists() else None

    # Minimal stub — see _precompute_voice_mlx for rationale
    audio_stub = mx.zeros((model.sample_rate,))

    return {
        "speaker_embed": speaker_embed,
        "ref_codes": ref_codes,
        "ref_text": ref_text,
        "audio": audio_stub,
    }


def _load_voices_mlx():
    """Load previously-uploaded voices from disk (MLX backend).

    Tries to load pre-computed embeddings (.npy) first; falls back to full
    recomputation from the WAV file if cached embeddings are missing.
    """
    if not VOICES_DIR.exists():
        return
    for voice_dir in sorted(VOICES_DIR.iterdir()):
        if not voice_dir.is_dir():
            continue
        meta_path = voice_dir / "meta.json"
        wav_path = voice_dir / "voice.wav"
        if not meta_path.exists() or not wav_path.exists():
            continue
        meta = json.loads(meta_path.read_text())
        voice_id = voice_dir.name
        ref_text = meta["ref_text"]

        # Try cached embeddings first (fast path — no model inference)
        prompt = _load_voice_cache_mlx(voice_dir, ref_text)
        if prompt is None:
            # Cold start: compute from WAV and persist for next time
            print(f"  computing voice prompt: {voice_id}")
            prompt = _precompute_voice_mlx(str(wav_path), ref_text)
            _save_voice_cache_mlx(voice_dir, prompt)
        else:
            print(f"  loaded cached voice: {voice_id}")

        voice_meta[voice_id] = {"ref_text": ref_text}
        _mlx_prompt_cache[voice_id] = prompt
    print(f"Loaded {len(voice_meta)} voices")


def _register_voice_mlx(voice_id: str, wav_path: str, ref_text: str):
    """Register a new voice — pre-compute and cache embeddings.

    Must be called from the GPU executor thread.
    """
    prompt = _precompute_voice_mlx(wav_path, ref_text)
    _save_voice_cache_mlx(VOICES_DIR / voice_id, prompt)
    voice_meta[voice_id] = {"ref_text": ref_text}
    _mlx_prompt_cache[voice_id] = prompt


def _generate_mlx(text: str, voice_id: str | None) -> bytes:
    """Generate TTS audio, injecting cached voice embeddings when available.

    When a voice_id has pre-computed data, we temporarily replace the model's
    extract_speaker_embedding and speech_tokenizer.encode with lambdas that
    return the cached values.  This is safe because the GPU executor is
    single-threaded — only one generation runs at a time.
    """
    import mlx.core as mx

    kwargs = {"text": text}

    original_extract = None
    original_encode = None

    if voice_id and voice_id in _mlx_prompt_cache:
        cached = _mlx_prompt_cache[voice_id]
        kwargs["ref_audio"] = cached["audio"]
        kwargs["ref_text"] = cached["ref_text"]

        # Inject cached speaker embedding — skip mel spectrogram + encoder CNN
        if cached["speaker_embed"] is not None:
            original_extract = model.extract_speaker_embedding
            _embed = cached["speaker_embed"]
            model.extract_speaker_embedding = lambda *_a, **_kw: _embed

        # Inject cached ref codes — skip speech tokenizer encoding
        if cached["ref_codes"] is not None:
            st = model.speech_tokenizer
            original_encode = st.encode
            _codes = cached["ref_codes"]
            st.encode = lambda *_a, **_kw: _codes

    try:
        chunks = []
        sample_rate = None
        for result in model.generate(**kwargs):
            chunks.append(np.array(result.audio))
            if sample_rate is None:
                sample_rate = result.sample_rate

        audio = np.concatenate(chunks)
        del chunks
        mx.clear_cache()
        gc.collect()

        buf = io.BytesIO()
        sf.write(buf, audio, sample_rate, subtype="PCM_16", format="WAV")
        return buf.getvalue()
    finally:
        # Always restore originals, even on error
        if original_extract is not None:
            model.extract_speaker_embedding = original_extract
        if original_encode is not None:
            model.speech_tokenizer.encode = original_encode


# ---------------------------------------------------------------------------
# PyTorch backend
# ---------------------------------------------------------------------------
AVAILABLE_MODELS = {
    "0.6B": "Qwen3-TTS-12Hz-0.6B-Base",
    "1.7B": "Qwen3-TTS-12Hz-1.7B-Base",
}
DEFAULT_PT_MODEL = os.environ.get("QWEN_TTS_MODEL", "1.7B")


def _load_pytorch():
    global model, model_name
    import torch
    from qwen_tts import Qwen3TTSModel

    if torch.cuda.is_available():
        device_map = "cuda"
        device_name = "cuda"
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device_map = "mps"
        device_name = "mps"
    else:
        device_map = "cpu"
        device_name = "cpu"

    model_key = DEFAULT_PT_MODEL
    if model_key not in AVAILABLE_MODELS:
        print(f"Unknown model key '{model_key}', falling back to 1.7B")
        model_key = "1.7B"
    model_name = AVAILABLE_MODELS[model_key]
    model_path = MODELS_DIR / model_name
    if not model_path.exists():
        raise RuntimeError(f"Model not found: {model_path}")
    print(f"Loading {model_name} on {device_name} …")
    model = Qwen3TTSModel.from_pretrained(
        str(model_path),
        device_map=device_map,
        dtype=torch.float32,
        attn_implementation="sdpa",
    )
    print("Model loaded.")


def _load_voices_pytorch():
    """Load previously-uploaded voices from disk (PyTorch backend)."""
    if not VOICES_DIR.exists():
        return
    for voice_dir in sorted(VOICES_DIR.iterdir()):
        if not voice_dir.is_dir():
            continue
        meta_path = voice_dir / "meta.json"
        wav_path = voice_dir / "voice.wav"
        if not meta_path.exists() or not wav_path.exists():
            continue
        meta = json.loads(meta_path.read_text())
        voice_id = voice_dir.name
        prompt = model.create_voice_clone_prompt(
            ref_audio=str(wav_path),
            ref_text=meta["ref_text"],
        )
        voice_prompt_cache[voice_id] = prompt
        print(f"  cached voice: {voice_id}")
    print(f"Loaded {len(voice_prompt_cache)} voices")


def _register_voice_pytorch(voice_id: str, wav_path: str, ref_text: str):
    prompt = model.create_voice_clone_prompt(
        ref_audio=wav_path,
        ref_text=ref_text,
    )
    voice_prompt_cache[voice_id] = prompt


def _generate_pytorch(text: str, voice_clone_prompt) -> bytes:
    wavs, sr = model.generate_voice_clone(
        text=text,
        language="English",
        voice_clone_prompt=voice_clone_prompt,
    )
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, subtype="PCM_16", format="WAV")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
@app.on_event("startup")
def startup():
    if RUNTIME == "mlx":
        _load_mlx()
        _load_voices_mlx()
    elif RUNTIME == "pytorch":
        _load_pytorch()
        _load_voices_pytorch()
    else:
        raise RuntimeError(
            f"Unknown QWEN_TTS_RUNTIME: {RUNTIME!r} (use 'mlx' or 'pytorch')"
        )


def _hash_audio(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


@app.post("/voices")
async def upload_voice(
    audio: UploadFile = File(...),
    ref_text: str = Form(...),
):
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio file")

    voice_id = _hash_audio(audio_bytes)

    # Already registered in memory — return immediately
    if RUNTIME == "mlx" and voice_id in _mlx_prompt_cache:
        return {"voice_id": voice_id}
    if RUNTIME == "pytorch" and voice_id in voice_prompt_cache:
        return {"voice_id": voice_id}

    # Persist to disk
    voice_dir = VOICES_DIR / voice_id
    voice_dir.mkdir(parents=True, exist_ok=True)
    wav_path = voice_dir / "voice.wav"
    wav_path.write_bytes(audio_bytes)
    (voice_dir / "meta.json").write_text(json.dumps({"ref_text": ref_text}))

    # Register in memory (both backends need GPU work)
    loop = asyncio.get_running_loop()
    if RUNTIME == "mlx":
        await loop.run_in_executor(
            _gpu_executor,
            _register_voice_mlx, voice_id, str(wav_path), ref_text,
        )
    else:
        await loop.run_in_executor(
            _gpu_executor,
            _register_voice_pytorch, voice_id, str(wav_path), ref_text,
        )

    print(f"Registered voice {voice_id}")
    return {"voice_id": voice_id}


@app.get("/voices")
def list_voices():
    if RUNTIME == "mlx":
        ids = sorted(voice_meta.keys())
    else:
        ids = sorted(voice_prompt_cache.keys())
    return {"voices": ids}


class TTSRequest(BaseModel):
    text: str
    voice_id: str | None = None


@app.post("/tts")
async def tts(req: TTSRequest):
    cache_key = (req.text, req.voice_id)
    cached = cache.get(cache_key)
    if cached is not None:
        return Response(content=cached, media_type="audio/wav")

    loop = asyncio.get_running_loop()

    if RUNTIME == "mlx":
        if req.voice_id and req.voice_id not in _mlx_prompt_cache:
            raise HTTPException(404, f"Unknown voice_id: {req.voice_id}")
        try:
            wav_bytes = await asyncio.wait_for(
                loop.run_in_executor(
                    _gpu_executor,
                    _generate_mlx, req.text, req.voice_id,
                ),
                timeout=TTS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, "TTS generation timed out")
    else:
        if not req.voice_id:
            raise HTTPException(400, "voice_id is required for PyTorch backend")
        if req.voice_id not in voice_prompt_cache:
            raise HTTPException(404, f"Unknown voice_id: {req.voice_id}")
        try:
            wav_bytes = await asyncio.wait_for(
                loop.run_in_executor(
                    _gpu_executor,
                    _generate_pytorch, req.text, voice_prompt_cache[req.voice_id],
                ),
                timeout=TTS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, "TTS generation timed out")

    cache.put(cache_key, wav_bytes)
    return Response(content=wav_bytes, media_type="audio/wav")


@app.get("/health")
def health():
    info = {
        "model": model_name,
        "runtime": RUNTIME,
    }

    if RUNTIME == "mlx":
        import mlx.core as mx
        info["device"] = "apple-silicon-mlx"
        info["voices"] = sorted(voice_meta.keys())
        info["memory_mb"] = {
            "active": round(mx.get_active_memory() / 1024 / 1024),
            "peak": round(mx.get_peak_memory() / 1024 / 1024),
            "cache": round(mx.get_cache_memory() / 1024 / 1024),
        }
        info["wav_cache_entries"] = len(cache._store)
    else:
        import torch
        if torch.cuda.is_available():
            info["device"] = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            info["device"] = "mps"
        else:
            info["device"] = "cpu"
        info["voices"] = sorted(voice_prompt_cache.keys())
        info["wav_cache_entries"] = len(cache._store)

    return info


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
