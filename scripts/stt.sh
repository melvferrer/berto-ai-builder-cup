#!/usr/bin/env bash
# Local Whisper speech-to-text for Berto (pm2 'berto-stt'). 127.0.0.1:8789 only. ~1 GB RAM with 'small' int8.
# Models live in ./models (git-ignored): huggingface Systran/faster-whisper-{small,base}.
set -euo pipefail
cd "$(dirname "$0")/.."
export OMP_NUM_THREADS="${STT_THREADS:-4}" HF_HUB_OFFLINE=1
exec nice -n 5 .venv/bin/python server/stt_worker.py
