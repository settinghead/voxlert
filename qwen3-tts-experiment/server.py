"""Qwen3-TTS FastAPI server for VoiceForge — dual MLX / PyTorch backend."""

import os
import io
import json
import asyncio
from pathlib import Path

import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

RUNTIME = os.environ.get("QWEN_TTS_RUNTIME", "mlx").lower()
PACKS_DIR = Path(__file__).resolve().parent.parent / "packs"
MODELS_DIR = Path(__file__).resolve().parent / "models"
PORT = 8100
TTS_TIMEOUT = 60

app = FastAPI(title="Qwen3-TTS Server")

# Filled at startup
model = None
model_name = None
pack_meta: dict[str, dict] = {}      # MLX: pack_id -> {ref_audio, ref_text}
prompt_cache: dict[str, list] = {}    # PyTorch: pack_id -> VoiceClonePromptItem list

# ---------------------------------------------------------------------------
# MLX backend
# ---------------------------------------------------------------------------
MLX_MODEL_ID = os.environ.get(
    "QWEN_TTS_MLX_MODEL",
    "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
)


def _load_mlx():
    global model, model_name
    from mlx_audio.tts.utils import load_model

    model_name = MLX_MODEL_ID.split("/")[-1]
    print(f"Loading MLX model {model_name} …")
    model = load_model(MLX_MODEL_ID)
    print("MLX model loaded.")


def _read_pack_meta():
    """Read voice.wav path + ref_text for every pack (MLX backend)."""
    for pack_dir in sorted(PACKS_DIR.iterdir()):
        pack_json = pack_dir / "pack.json"
        voice_wav = pack_dir / "voice.wav"
        if not pack_json.exists() or not voice_wav.exists():
            continue
        meta = json.loads(pack_json.read_text())
        ref_text = meta.get("ref_text", "")
        if not ref_text:
            continue
        pack_id = pack_dir.name
        pack_meta[pack_id] = {
            "ref_audio": str(voice_wav),
            "ref_text": ref_text,
        }
        print(f"  pack: {pack_id}")
    print(f"Pack metadata ready — {len(pack_meta)} packs")


def _generate_mlx(text: str, ref_audio: str, ref_text: str) -> tuple[bytes, int]:
    """Run MLX generation, return (wav_bytes, sample_rate)."""
    import numpy as np

    chunks = []
    sample_rate = None
    for result in model.generate(
        text=text,
        ref_audio=ref_audio,
        ref_text=ref_text,
    ):
        chunks.append(np.array(result.audio))
        if sample_rate is None:
            sample_rate = result.sample_rate

    audio = np.concatenate(chunks)
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, subtype="PCM_16", format="WAV")
    return buf.getvalue()


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

    model_key = DEFAULT_PT_MODEL
    if model_key not in AVAILABLE_MODELS:
        print(f"Unknown model key '{model_key}', falling back to 1.7B")
        model_key = "1.7B"
    model_name = AVAILABLE_MODELS[model_key]
    model_path = MODELS_DIR / model_name
    if not model_path.exists():
        raise RuntimeError(f"Model not found: {model_path}")
    print(f"Loading {model_name} on MPS …")
    model = Qwen3TTSModel.from_pretrained(
        str(model_path),
        device_map="mps",
        dtype=torch.float32,
        attn_implementation="sdpa",
    )
    print("Model loaded.")


def _cache_pack_prompts():
    """Pre-build voice-clone prompts for every pack (PyTorch backend)."""
    for pack_dir in sorted(PACKS_DIR.iterdir()):
        pack_json = pack_dir / "pack.json"
        voice_wav = pack_dir / "voice.wav"
        if not pack_json.exists() or not voice_wav.exists():
            continue
        meta = json.loads(pack_json.read_text())
        ref_text = meta.get("ref_text", "")
        if not ref_text:
            continue
        pack_id = pack_dir.name
        prompt = model.create_voice_clone_prompt(
            ref_audio=str(voice_wav),
            ref_text=ref_text,
        )
        prompt_cache[pack_id] = prompt
        print(f"  cached: {pack_id}")
    print(f"Prompt cache ready — {len(prompt_cache)} packs")


def _generate_pytorch(text: str, voice_clone_prompt) -> bytes:
    """Run PyTorch generation, return wav bytes."""
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
        _read_pack_meta()
    elif RUNTIME == "pytorch":
        _load_pytorch()
        _cache_pack_prompts()
    else:
        raise RuntimeError(f"Unknown QWEN_TTS_RUNTIME: {RUNTIME!r} (use 'mlx' or 'pytorch')")


class TTSRequest(BaseModel):
    text: str
    pack_id: str


@app.post("/tts")
async def tts(req: TTSRequest):
    if RUNTIME == "mlx":
        if req.pack_id not in pack_meta:
            raise HTTPException(404, f"Unknown pack_id: {req.pack_id}")
        meta = pack_meta[req.pack_id]
        try:
            wav_bytes = await asyncio.wait_for(
                asyncio.to_thread(
                    _generate_mlx, req.text, meta["ref_audio"], meta["ref_text"]
                ),
                timeout=TTS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, "TTS generation timed out")
    else:
        if req.pack_id not in prompt_cache:
            raise HTTPException(404, f"Unknown pack_id: {req.pack_id}")
        try:
            wav_bytes = await asyncio.wait_for(
                asyncio.to_thread(
                    _generate_pytorch, req.text, prompt_cache[req.pack_id]
                ),
                timeout=TTS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, "TTS generation timed out")

    return Response(content=wav_bytes, media_type="audio/wav")


@app.get("/health")
def health():
    packs = sorted(pack_meta.keys()) if RUNTIME == "mlx" else sorted(prompt_cache.keys())
    device = "apple-silicon-mlx" if RUNTIME == "mlx" else "mps"
    return {
        "model": model_name,
        "runtime": RUNTIME,
        "device": device,
        "cached_packs": packs,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
