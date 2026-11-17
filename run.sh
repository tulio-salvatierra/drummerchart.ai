#!/usr/bin/env bash
# One command: create the venv, install dependencies, start the app on http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in python3.12 python3.13 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
  done
fi
[ -n "$PYTHON" ] || { echo "Python 3.11+ is required (3.12 recommended)." >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo "Note: ffmpeg not found. It is only needed to build the test fixtures."

if [ ! -d .venv ]; then
  echo "Creating .venv with $PYTHON"
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

STAMP=".venv/.deps-$(cat requirements.txt requirements-madmom.txt | cksum | cut -d' ' -f1)"
if [ ! -f "$STAMP" ]; then
  python -m pip install --quiet --upgrade pip
  python -m pip install --quiet -r requirements.txt
  if python -m pip install --quiet -r requirements-madmom.txt; then
    echo "madmom installed: downbeats use the neural model."
  else
    echo "WARNING: madmom did not install (needs git and a C compiler)."
    echo "         The app still works; downbeats/meter use the built-in heuristic."
  fi
  rm -f .venv/.deps-* && touch "$STAMP"
fi

exec uvicorn app:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" "$@"
