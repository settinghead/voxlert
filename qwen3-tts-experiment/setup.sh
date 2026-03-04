#!/usr/bin/env bash
#
# First-time setup for the Qwen3-TTS experiment server.
# Creates a venv, installs dependencies, and downloads models.
#
set -euo pipefail
cd "$(dirname "$0")"

# ── Colours ──────────────────────────────────────────────────────────────────
bold=$(tput bold 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true)
red=$(tput setaf 1 2>/dev/null || true)
yellow=$(tput setaf 3 2>/dev/null || true)

info()  { echo "${bold}${green}==> ${reset}${bold}$*${reset}"; }
warn()  { echo "${bold}${yellow}==> ${reset}${bold}$*${reset}"; }
fail()  { echo "${bold}${red}==> ${reset}${bold}$*${reset}"; exit 1; }

# ── Pre-flight checks ───────────────────────────────────────────────────────
info "Checking prerequisites…"

# Apple Silicon
arch=$(uname -m)
if [[ "$arch" != "arm64" ]]; then
    fail "Apple Silicon (arm64) required — detected $arch."
fi
echo "  Architecture: $arch"

# Python 3.13+
if ! command -v python3 &>/dev/null; then
    fail "python3 not found. Install Python 3.13+ first."
fi
py_version=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
py_major=$(echo "$py_version" | cut -d. -f1)
py_minor=$(echo "$py_version" | cut -d. -f2)
if (( py_major < 3 || py_minor < 13 )); then
    fail "Python 3.13+ required — detected $py_version."
fi
echo "  Python: $py_version"

# ── Virtual environment ──────────────────────────────────────────────────────
if [[ -d venv ]]; then
    info "Virtual environment already exists — skipping creation."
else
    info "Creating virtual environment…"
    python3 -m venv venv
fi
source venv/bin/activate

# ── Install dependencies ─────────────────────────────────────────────────────
info "Installing Python dependencies (this may take a few minutes)…"
pip install --upgrade pip -q
pip install -r requirements.txt -q
echo "  Done."

# ── Download models ──────────────────────────────────────────────────────────
info "Downloading PyTorch models…"
mkdir -p models

download_model() {
    local repo="$1"
    local dest="models/$(basename "$repo")"
    if [[ -d "$dest" ]]; then
        echo "  $dest already exists — skipping."
        return
    fi
    echo "  Downloading $repo …"
    python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('$repo', local_dir='$dest')
"
    echo "  Saved to $dest"
}

# 1.7B model (default)
download_model "Qwen/Qwen3-TTS-12Hz-1.7B-Base"

# 0.6B model (optional)
echo ""
read -rp "${bold}Download the smaller 0.6B model too? [y/N] ${reset}" choice
if [[ "${choice,,}" == "y" ]]; then
    download_model "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
fi

# ── Verify imports ───────────────────────────────────────────────────────────
info "Verifying key imports…"
python3 -c "
import mlx.core; print(f'  mlx {mlx.core.__version__}')
import torch; print(f'  torch {torch.__version__}')
from mlx_audio.tts.utils import load_model; print('  mlx_audio OK')
from qwen_tts import Qwen3TTSModel; print('  qwen_tts OK')
import soundfile; print('  soundfile OK')
import fastapi; print('  fastapi OK')
"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "Setup complete!"
echo ""
echo "  Start the server (MLX backend — default):"
echo "    ${bold}./run.sh${reset}"
echo ""
echo "  Or use the PyTorch backend:"
echo "    ${bold}QWEN_TTS_RUNTIME=pytorch ./run.sh${reset}"
echo ""
echo "  Test it:"
echo "    ${bold}curl -X POST http://localhost:8100/tts \\${reset}"
echo "      ${bold}-H 'Content-Type: application/json' \\${reset}"
echo "      ${bold}-d '{\"text\": \"Hello world\", \"pack_id\": \"sc2-kerrigan\"}' \\${reset}"
echo "      ${bold}--output test.wav${reset}"
echo ""
