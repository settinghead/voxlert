# Qwen3-TTS Experiment

A FastAPI server that uses [Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) for voice-cloned text-to-speech. Give it a voice pack (a short WAV reference + transcript) and it generates speech in that voice. Supports both an MLX backend (quantized, fast on Apple Silicon) and a PyTorch backend (full-precision via MPS).

## Prerequisites

- **Apple Silicon** Mac (M1/M2/M3/M4)
- **Python 3.13+**
- **16 GB RAM** minimum (32 GB recommended for 1.7B model)
- **~8 GB disk** for models + dependencies

## Quick start

```bash
# 1. Run first-time setup (venv, deps, model download)
./setup.sh

# 2. Start the server (MLX backend by default)
./run.sh

# 3. Generate speech
curl -X POST http://localhost:8100/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hello world", "pack_id": "sc2-kerrigan"}' \
  --output hello.wav
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `QWEN_TTS_RUNTIME` | `mlx` | Backend to use: `mlx` or `pytorch` |
| `QWEN_TTS_MLX_MODEL` | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit` | HuggingFace model ID for the MLX backend |
| `QWEN_TTS_MODEL` | `1.7B` | PyTorch model size: `1.7B` or `0.6B` |

Example — run with PyTorch and the smaller model:

```bash
QWEN_TTS_RUNTIME=pytorch QWEN_TTS_MODEL=0.6B ./run.sh
```

## API endpoints

### `POST /tts`

Generate speech from text using a voice pack.

**Request:**

```json
{"text": "The swarm consumes all.", "pack_id": "sc2-kerrigan"}
```

**Response:** `audio/wav` (PCM 16-bit)

**Errors:** `404` if pack_id not found, `504` if generation exceeds 60 s timeout.

```bash
curl -X POST http://localhost:8100/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Nuclear launch detected.", "pack_id": "sc2-adjutant"}' \
  --output speech.wav
```

### `GET /health`

Returns server status, loaded model, runtime, and available voice packs.

```bash
curl http://localhost:8100/health | python3 -m json.tool
```

```json
{
    "model": "Qwen3-TTS-12Hz-1.7B-Base-8bit",
    "runtime": "mlx",
    "device": "apple-silicon-mlx",
    "cached_packs": ["hl-hev-suit", "red-alert-eva", "sc2-kerrigan", "..."]
}
```

## Scripts reference

| Script | Purpose |
|---|---|
| `server.py` | FastAPI TTS server (the main application) |
| `run.sh` | Activates venv and starts the server |
| `setup.sh` | First-time setup: venv, deps, model download |
| `test_clone.py` | Generate a single voice-cloned WAV for one pack. Usage: `python test_clone.py [pack_id] [text]` |
| `batch_clone.py` | Generate voice-cloned WAVs for 9 predefined packs with character-appropriate lines |
| `benchmark.py` | Benchmark generation time vs text length across packs. Usage: `python benchmark.py [1.7B\|0.6B]` |
| `transcribe_packs.py` | Transcribe all voice pack WAVs using Whisper (`base.en`) and write `ref_text` into each `pack.json` |
| `transcribe_packs_v2.py` | Same as above but uses Whisper `medium.en` for higher accuracy |

The test/benchmark scripts use the **PyTorch** backend directly (not the server). Activate the venv first:

```bash
source venv/bin/activate
python test_clone.py sc2-kerrigan "Evolution is inevitable."
```

## Voice packs

Voice packs live in `../packs/` (the repository-level `packs/` directory). Each pack is a directory containing:

- **`pack.json`** — metadata including `ref_text` (the transcript of the reference audio)
- **`voice.wav`** — a short reference audio clip of the target voice

The server reads all packs at startup and caches them. Only packs that have both `voice.wav` and a non-empty `ref_text` in `pack.json` are loaded.

## Troubleshooting

**Segfault or crash under concurrent requests**
MLX and PyTorch MPS are not thread-safe. The server serializes all inference behind a lock, but sending many requests in rapid succession can still cause memory pressure. Stick to one request at a time.

**Model not found (PyTorch backend)**
The PyTorch backend looks for models in `models/Qwen3-TTS-12Hz-{size}-Base`. Run `./setup.sh` to download them, or manually:

```bash
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Qwen/Qwen3-TTS-12Hz-1.7B-Base', local_dir='models/Qwen3-TTS-12Hz-1.7B-Base')
"
```

**MPS not available**
Ensure you're on Apple Silicon with a recent macOS. Check with:

```bash
python3 -c "import torch; print(torch.backends.mps.is_available())"
```

**MLX model download fails**
The MLX backend auto-downloads from HuggingFace on first run. If you're behind a proxy, set `HF_HUB_OFFLINE=0` and ensure `huggingface_hub` can reach the internet.

**Pack not showing in /health**
The pack needs both `voice.wav` and a non-empty `ref_text` field in `pack.json`. Run `transcribe_packs_v2.py` to auto-generate transcripts.
