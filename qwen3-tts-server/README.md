# Qwen3-TTS (VoiceForge TTS backend)

A FastAPI server that uses [Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) for voice-cloned text-to-speech. Give it a voice pack (a short WAV reference + transcript) and it generates speech in that voice.

## Installation

### Prerequisites

- **Python 3.13+**
- **16 GB RAM** minimum (32 GB recommended for 1.7B model)
- **~8 GB disk** for models + dependencies
- **Backend-specific:**
  - **MLX** (recommended on Mac): Apple Silicon (M1/M2/M3/M4)
  - **PyTorch + MPS**: Apple Silicon, macOS
  - **PyTorch + CUDA**: Linux or Windows with an NVIDIA GPU

### Quick start

**macOS / Linux:** Run the setup script, then start the server:

```bash
# 1. Run first-time setup (venv, deps, model download)
./setup.sh

# 2. Start the server (MLX backend by default on Mac; see Backends below)
./run.sh

# Or run it from a uv-managed environment
uv run ./run.sh

# 3. Point VoiceForge at it
voiceforge config set tts_backend qwen
```

**Windows:** The scripts above are bash (e.g. `setup.sh`, `run.sh`). Use **WSL** or **Git Bash** to run them, or do the steps manually: create a venv, `pip install -r requirements.txt`, download the PyTorch models (see Troubleshooting → "Model not found"), then run `python server.py` with `QWEN_TTS_RUNTIME=pytorch` and ensure the voiceforge `packs/` directory is available (e.g. clone the full voiceforge repo and run the server from `qwen3-tts-server`).

Generate speech directly:

```bash
curl -X POST http://localhost:8100/tts \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hello world", "pack_id": "sc2-kerrigan"}' \
  --output hello.wav
```

## Backends

| Backend | Best for | Runtime flag | Models |
|---------|----------|--------------|--------|
| **MLX** | Apple Silicon Macs (quantized, fast) | `QWEN_TTS_RUNTIME=mlx` (default on Mac) | Different 8-bit model; **downloaded automatically** when the server starts with MLX |
| **PyTorch + MPS** | Apple Silicon Macs (full precision) | `QWEN_TTS_RUNTIME=pytorch` on macOS | Same as CUDA — see below |
| **PyTorch + CUDA** | Linux/Windows with NVIDIA GPU | `QWEN_TTS_RUNTIME=pytorch` when CUDA is available | **Same** HuggingFace models as MPS; `./setup.sh` downloads them |

**PyTorch (MPS and CUDA)** use the same model checkpoints (`Qwen/Qwen3-TTS-12Hz-1.7B-Base` and optionally `0.6B`). No separate download for CUDA — run `./setup.sh` once; it downloads the PyTorch models and works on both Apple (MPS) and Linux/Windows (CUDA). **MLX** uses a different, quantized model and fetches it on first run.

The server chooses PyTorch device automatically: CUDA if available, else MPS (Apple), else CPU.

Example — run with PyTorch (MPS on Mac, or CUDA on Linux/Windows):

```bash
QWEN_TTS_RUNTIME=pytorch QWEN_TTS_MODEL=0.6B ./run.sh
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_TTS_RUNTIME` | `mlx` | Backend: `mlx` or `pytorch` |
| `QWEN_TTS_MLX_MODEL` | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit` | HuggingFace model ID for MLX |
| `QWEN_TTS_MODEL` | `1.7B` | PyTorch model size: `1.7B` or `0.6B` |

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

`device` can be `apple-silicon-mlx`, `mps`, `cuda`, or `cpu`.

## Scripts reference

| Script | Purpose |
|--------|---------|
| `server.py` | FastAPI TTS server (the main application) |
| `run.sh` | Starts the server using `venv/bin/python`, `python`, or `python3` |
| `setup.sh` | First-time setup: creates or repairs `venv`, installs deps, downloads models |

## Voice packs

Voice packs live in `../packs/` (the repository-level `packs/` directory). Each pack is a directory containing:

- **`pack.json`** — metadata including `ref_text` (the transcript of the reference audio)
- **`voice.wav`** — a short reference audio clip of the target voice

The server reads all packs at startup and caches them. Only packs that have both `voice.wav` and a non-empty `ref_text` in `pack.json` are loaded.

## Troubleshooting

**Segfault or crash under concurrent requests**  
MLX and PyTorch MPS/CUDA are not fully thread-safe. The server serializes all inference behind a lock, but sending many requests in rapid succession can still cause memory pressure. Stick to one request at a time.

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

**CUDA not used on Linux/Windows**  
Ensure PyTorch is installed with CUDA support and a GPU is available:

```bash
python3 -c "import torch; print('CUDA:', torch.cuda.is_available())"
```

**MLX model download fails**  
The MLX backend auto-downloads from HuggingFace on first run. If you're behind a proxy, set `HF_HUB_OFFLINE=0` and ensure `huggingface_hub` can reach the internet.

**Pack not showing in /health**  
The pack needs both `voice.wav` and a non-empty `ref_text` field in `pack.json`. Existing public packs already include `ref_text`; if you are authoring new packs, add a transcript before starting the server.
