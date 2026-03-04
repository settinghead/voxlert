#!/usr/bin/env bash
cd "$(dirname "$0")"
source venv/bin/activate

MAX_RESTARTS=10
COOLDOWN=3
restarts=0

while true; do
    echo "==> Starting Qwen3-TTS server (restart #$restarts)…"
    QWEN_TTS_RUNTIME=${QWEN_TTS_RUNTIME:-mlx} python server.py
    exit_code=$?

    if [[ $exit_code -eq 0 ]]; then
        echo "==> Server exited cleanly."
        break
    fi

    restarts=$((restarts + 1))
    if (( restarts >= MAX_RESTARTS )); then
        echo "==> Crashed $restarts times — giving up."
        exit 1
    fi

    echo "==> Server crashed (exit $exit_code). Restarting in ${COOLDOWN}s… ($restarts/$MAX_RESTARTS)"
    sleep "$COOLDOWN"
done
