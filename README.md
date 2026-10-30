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

## Tempo-first review

The browser now calls `POST /tempo` first: beat timing, median BPM, an
interval-tempo plot and a central 10th–90th percentile spread, without section
detection or WAV generation. Listen to the original and explicitly approve
before continuing. Keep detected beat timing (default), or enable a corrected
map with rows of beat-anchor seconds and BPM. Add/remove rows for tempo changes;
anchors must increase and BPM must be 20–400. Each anchor resets beat phase.
This is a piecewise constant tempo map; gradual ramps need multiple rows or
the original detected beats. The graph shows the prediction, not the edited grid.

`POST /tempo/approve` validates confirmation and the audio SHA-256, creates the
reviewed beat grid, then detects sections using that grid and renders the WAV.
Editing the map hides the old result and clears approval. Export includes
predicted tempo data, corrected segments, approved beats and source hash.
Legacy `/analyze` and `/analyze/result` retain their original direct-generation
contracts; the new approval gate applies to the browser workflow and new routes.

The steady/variable indication is a heuristic, not confidence or proof of
constant tempo. The existing tracker can miss tempo changes or choose half/double
time. Tempo changes are not automatically labeled as song sections.

## Meter and first ONE

Tempo review now includes a manual 3/4 starting point for the Saraiman review,
with 2/4 and 4/4 alternatives. BPM always denotes quarter notes. Mark the original
audio playhead as ONE or type seconds; the requested position snaps to the nearest
reviewed beat. The audition reports the actual snapped position. It does not
shift beat timing. Beats before ONE are unaccented pickups.

Build count audition calls /tempo/audition and produces a stereo WAV (song left,
click right), with a higher 1800 Hz accent every N beats versus 1200 Hz regular
clicks. It does not detect sections or approve the map. Changing tempo, meter,
or ONE stops/hides the stale audition and invalidates approval. Explicit approval
uses the same accents for the resulting click and includes meter, requested and
snapped ONE, beat index, downbeat times and confirmation in the JSON export.
Legacy calls without meter retain their unaccented behavior.

One constant quarter-note meter per song is supported. Automatic meter detection,
odd/compound grouping, meter changes and spoken counting are not implemented.
The default first beat is only a provisional ONE, not a verified downbeat.
