#!/usr/bin/env bash
cd "$(dirname "$0")"
source venv/bin/activate
QWEN_TTS_RUNTIME=${QWEN_TTS_RUNTIME:-mlx} python server.py
