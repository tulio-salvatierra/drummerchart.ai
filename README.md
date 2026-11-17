# Drummer Chart AI — Pass 2

Upload an MP3 of a full song. In under a minute you land on an editor where the detected
section changes are draggable markers, each with a time signature. Fix anything while
listening to a live click preview, then download the click track (standalone, and mixed
with the song). Runs locally; nothing is deployed.

> The repo-root `index.html` is the marketing landing page deployed on Vercel. It is not
> part of the app. App templates live in `templates/`.

## Run locally

```bash
./run.sh
```

Creates `.venv`, installs dependencies and starts the app at <http://127.0.0.1:8000>.
Needs Python 3.11+ (3.12 recommended). `PORT=9000 ./run.sh` changes the port;
`./run.sh --reload` passes flags to uvicorn.

`run.sh` also tries to install [madmom](https://github.com/CPJKU/madmom) from GitHub for
the downbeat model (needs `git` and a C compiler; on macOS: `xcode-select --install`).
If that fails the app still works and uses the built-in heuristic instead.

### Docker

```bash
docker build -t drummerchart-ai .
docker run --rm -p 8000:8000 drummerchart-ai
```

## Using the editor

| Action | How |
|---|---|
| Play / pause | `Space`, or the play button |
| Seek | Click the timeline (`←` / `→` jump 5 s when no marker is selected) |
| Move a marker | Drag it. It snaps to the nearest beat; hold `Shift` to snap to downbeats |
| Nudge the selected marker | `←` / `→` one beat, `Shift` + arrow one bar |
| Change a marker's time signature | Click the marker, then one of 2/4 3/4 4/4 5/4 6/8 7/8 12/8 |
| Label a marker | Click it and type (Intro, Verse, Chorus...) |
| Add a marker | Double-click the timeline, or press `M` to drop one at the playhead |
| Delete the selected marker | `Delete` / `Backspace` |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Zoom | The zoom slider, or `Ctrl/Cmd` + scroll |
| What you hear | Song / Song + click / Click |
| Download | "Download click track" renders both WAVs from the markers on screen |

- The first marker is the first beat of the song. Its meter can change; it can't be moved
  or deleted.
- Outlined, dimmed markers with a `?` are low-confidence meter guesses (below 50%). They
  default to 4/4 until you pick one.
- Edits are kept in the browser (localStorage) until the job expires. "Reset to detected"
  goes back to the analysis.

### What the click does

- Normal click on every beat, a higher and louder click on beat 1 of each bar.
- Bars restart at every marker, using that marker's time signature.
- A low cue tone plays exactly one bar before each section change (the bar length of the
  section you're leaving), then a bright accent on the change itself.
- A one-bar count-in before the first beat, if the song has that much lead-in.

### How time signatures map onto the beat grid

The detected beat grid is never re-spaced. A time signature only says how many detected
beats make a bar: 2/4 = 2, 3/4 = 3, 4/4 = 4, 5/4 = 5, 6/8 = 6, 7/8 = 7, 12/8 = 12. So in
6/8 each detected beat is treated as an eighth note. If the tracker locked onto the dotted
quarter of a 6/8 song instead (two pulses per bar), pick 2/4.

## How it works

```
POST /analyze                 validate, save jobs/<id>/input.mp3, analyze once,
                              save jobs/<id>/analysis.json, redirect to /job/<id>
GET  /job/<id>                editor page
GET  /job/<id>/analysis       {job_id, duration, bpm, beats, downbeats, markers[]}
GET  /job/<id>/audio          the original upload
POST /render/<id>             body {markers: [...]} -> renders click.wav + mix.wav from the
                              SAVED beats (no analysis), returns download URLs
GET  /job/<id>/download/<click|mix>
```

| File | Role |
|---|---|
| `app.py` | FastAPI routes, upload limits, marker validation |
| `jobs.py` | One folder per job, id validation, 2-hour cleanup |
| `analyzer.py` | Beats (librosa), BPM, section boundaries (self-similarity novelty), markers |
| `meter.py` | Downbeat phase + meter per section (madmom activation + low-frequency accents) |
| `schedule.py` | `build_click_schedule(beats, markers, duration)`: the single definition of what plays when |
| `static/schedule.js` | The same function for the browser preview |
| `clicktrack.py` | Renders the schedule to WAV: click only, and song + click |
| `static/editor.js` | Timeline, markers, undo, Web Audio click preview |

Markers are the single source of truth for sections: `{time, meter, meter_confidence,
label}`. A section ends where the next marker starts.

Limits: MP3 only, 20 MB, 10 minutes. Jobs older than 2 hours are deleted at startup and
on every upload.

## Tests

```bash
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

Needs `ffmpeg` (to encode the fixture MP3s) and `node` (to run `static/schedule.js` for the
preview/render parity test). The first run synthesizes four songs with known ground truth
into `tests/fixtures/` (`scripts/make_fixtures.py`): drums with the kick on beat 1 plus a
bass/chord layer whose harmony and timbre change at each section boundary.

The suite checks BPM, beat timing, boundary detection, meter accuracy, the schedule rules,
Python/JS schedule parity, WAV length and clipping, and the whole API flow.

## What changed in Pass 2

- Analysis and rendering are split. Upload analyzes once; downloads render from saved
  beats plus your markers.
- Analysis now returns BPM, downbeats, and a meter guess with confidence per section.
- Beat times are refined onto the nearest onset (about 3 ms resolution instead of 23 ms)
  and the grid is extended to the song's first and last beats.
- Section detection uses a checkerboard-kernel novelty curve on the self-similarity
  matrix, so it reacts to changes that last several bars and ignores bar-to-bar chords.
- Click rendering knows about meter: downbeat accents, a pre-cue one bar before each
  marker, a count-in, and a second WAV with the song mixed in.
- New marker editor with live in-browser click preview.
- Per-job folders with cleanup, upload limits, `run.sh`, tests.
- `output/` is gone; files live in `jobs/<id>/`.

## Known limitations

- **Tested on synthetic songs only.** Passing those tests does not mean it works on real
  recordings. The real-song listening test is still to do.
- **Steady tempo assumed.** The click follows the beat tracker's grid. Rubato, tempo
  changes, fermatas and long drum-less intros will drift or mis-track; there is no tempo
  map editing.
- **Half/double time.** The tracker can lock onto half or double the felt tempo. Meters
  then look wrong (4/4 reads as 2/4, and so on). No fix in the editor yet beyond picking
  the meter that matches the grid.
- **Kick on 1 and 3.** The meter guess leans on accents. Songs with equal kicks on 1 and 3
  can read as 2/4; sparse or syncopated drumming lowers confidence.
- **Pickup beats.** The first marker is always the first detected beat. If the song starts
  with a pickup, the analyzer adds a "Bar 1" marker on the first real downbeat.
- **Meter changes without a harmony or timbre change** are not detected as boundaries. Add
  the marker by hand.
- **Preview latency.** The browser preview schedules clicks against the audio element's
  clock. Bluetooth headphones or unusual audio setups can shift the click against the
  song by a few tens of milliseconds in the preview. The downloaded WAVs are sample-exact.
- Odd meters (5/4, 7/8) are never auto-detected, only 2/4, 3/4, 4/4 and 6/8. Set them by
  hand.
- One process, no queue: one analysis at a time is the expected load.
