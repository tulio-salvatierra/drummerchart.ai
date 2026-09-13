# Drummer Chart AI — Pass 1

The lean proof-of-concept: upload an MP3 and download a WAV click track whose clicks follow the detected beat grid and whose distinct low cues mark detected structural changes.

## Scope

- One FastAPI service
- Plain HTML upload form
- `POST /analyze`
- `librosa` beat detection
- Chroma + MFCC self-similarity structural-change detection
- Section candidates snapped to detected beats
- WAV click-track rendering

No auth, database, Next.js, YouTube ingestion, visual timeline, voice cues, or click customization in Pass 1.

## Run locally

Python 3.12 and FFmpeg are recommended.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload
```

Open `http://127.0.0.1:8000`, choose an MP3, and upload it. The response downloads `<song>_clicktrack.wav`.

## Docker

```bash
docker build -t drummerchart-ai .
docker run --rm -p 8000:8000 drummerchart-ai
```

## Pass 1 listening test

Use a song whose arrangement you know well. Play the returned WAV alongside the original and evaluate two things:

1. Do the clicks stay on the song's actual beat grid?
2. Do the lower/longer cues land on useful section changes?

The second question is the main experiment. Boundary detection is intentionally simple and tunable rather than presented as a finished verse/chorus classifier.
