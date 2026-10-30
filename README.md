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

## Pass 2B draft review UI

Run the existing FastAPI app and open `/`. Upload an MP3 to see original
and generated-click waveforms side by side. Both buffers use one Web Audio
clock and shared play/pause/seek; volume is independent. Select a timeline
section, rename it or change its start time, split at the playhead, or merge
with the next section. Beat snapping is enabled by default. First/last
endpoints remain fixed and invalid/zero-length sections are rejected.

The existing analyzer predicts change boundaries only. Labels begin as Unknown,
unconfirmed; confirmation is explicit and edits invalidate affected confirmation.
Export JSON retains original predictions, corrected sections, confirmation
states, beats, source filename, analysis version and export time. No database
or training runs. Corrections are lost on reload unless exported. Editing
boundaries does not regenerate click cues.

Legacy `POST /analyze` still returns WAV. New `POST /analyze/result` returns
metadata and inline base64 WAV, keeping temporary files isolated per request.
This draft buffers complete audio in memory and is intended for individual
songs, not large uploads. No upload-size guard or persistent audio identity
hash is added. Boundary moves use numeric controls rather than dragging.

Checks: `node --test tests/chart.test.mjs`; `python -m pytest tests/test_api.py`.
The integration fixture is synthetic WAV content with an MP3 upload filename;
it verifies decoding, actual analysis and WAV rendering, but not MP3 codec
compatibility or musical recognition accuracy. Browser playback/listening
requires manual verification.
