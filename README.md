# Drummer Chart AI

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

### Deploy (Railway)

The repo deploys as-is on [Railway](https://railway.com): New Project → Deploy from GitHub
repo → `tulio-salvatierra/drummerchart.ai`. `railway.json` tells it to build the
`Dockerfile`; the app listens on Railway's `$PORT`. Then Settings → Networking →
Generate Domain for a public URL. Analysis peaks around 1.2 GB of memory on a 4-minute
song (more for longer songs), so leave the service's memory limit at 4 GB or more.

### Docker

```bash
docker build -t drummerchart-ai .
docker run --rm -p 8000:8000 drummerchart-ai
```

## Using the app

Everything happens on one page: the pitch and the upload box at the top. After you drop a
song, the page turns into the workspace (the URL becomes `/job/<id>`, so a reload keeps you there).

| Action | How |
|---|---|
| Play / pause | `Space`, or the play button |
| Seek | Click the lane or a section on the song map (`←` / `→` jump 5 s when nothing is selected) |
| Move a marker | Drag it. It snaps to beats; hold `Shift` to snap to bar lines |
| Set where the 1 is | Drag the green **1** onto the first downbeat. Beats before it are pickup beats |
| Nudge the selected marker | `←` / `→` one beat, `Shift` + arrow one bar |
| Time signature, label | Click a marker: 2/4 3/4 4/4 5/4 6/8 7/8 12/8, and a label (Intro, Verse, Chorus…) |
| Voice cue | Click a marker → **Record cue** → say “Chorus, Metallica” → **Stop**. It plays one bar before the marker instead of the cue tone |
| Add / delete a marker | Double-click the lane or press `M` · select it and press `Delete` |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Loop a section | `L`, or the Loop button (click a section on the song map to loop that one) |
| Practice view | `P`, or Practice. Big section name, bar · beat, and what's coming next. On a phone it fills the screen |
| Speed | 60–100% (preview only; downloads are always 100%) |
| Count-in | Off, 1 bar or 2 bars, always counting into the 1 |
| Click accents | Tap each beat: Loud → Normal → Soft → Off, per time signature, or use a preset |
| Beat grid off? | “Beat grid: Half time / Double time” re-reads the detected beats |
| Download | Renders both WAVs from exactly what's on screen |

- Outlined markers with a `?` are unsure time-signature guesses (below 50%). They default
  to 4/4 until you pick one.
- Edits stay in the browser (localStorage) until the job expires. "Reset to detected" goes
  back to the analysis.

### What the click does

- Every beat clicks at its accent level: loud (high click) on beat 1 by default, normal on
  the rest. 6/8, 9/8 and 12/8 default to a dotted-quarter feel (loud 1, normal 4, soft
  elsewhere).
- Bars restart at every marker, using that marker's time signature.
- One bar before each section change: your voice cue if the marker has one, otherwise a
  low cue tone. Then a bright accent on the change itself.
- Count-in clicks before the 1, extrapolated back from the beat if the song starts right away.

### How time signatures map onto the beat grid

The detected beat grid is never re-spaced. A time signature only says how many detected
beats make a bar: 2/4 = 2, 3/4 = 3, 4/4 = 4, 5/4 = 5, 6/8 = 6, 7/8 = 7, 12/8 = 12. So in
6/8 each detected beat is treated as an eighth note. If the tracker locked onto the dotted
quarter of a 6/8 song instead (two pulses per bar), pick 2/4, or try "Double time".

## How it works

```
POST /analyze                 validate, save jobs/<id>/input.mp3, analyze once,
                              save jobs/<id>/analysis.json, redirect to /job/<id>
GET  /                       the page (pitch + upload)
GET  /job/<id>                the same page, with that song loaded
GET  /job/<id>/analysis       {job_id, duration, bpm, beats, downbeats, markers[]}
GET  /job/<id>/audio          the original upload
POST /job/<id>/voice          a recorded voice cue (WAV, made in the browser) -> {id}
GET  /job/<id>/voice/<note>   that voice cue
POST /render/<id>             body {markers: [...], settings: {count_in_bars, grid, accents}}
                              -> renders click.wav + mix.wav from the SAVED beats (no
                              analysis), returns download URLs
GET  /job/<id>/download/<click|mix>
```

| File | Role |
|---|---|
| `app.py` | FastAPI routes, upload limits, marker validation |
| `jobs.py` | One folder per job, id validation, 2-hour cleanup |
| `analyzer.py` | Beats (madmom's neural beat model, librosa fallback), BPM, section boundaries (self-similarity novelty), markers |
| `meter.py` | Downbeat phase + meter per section (madmom activation + low-frequency accents) |
| `schedule.py` | `build_click_schedule(beats, markers, duration)`: the single definition of what plays when |
| `static/schedule.js` | The same function for the browser preview |
| `clicktrack.py` | Renders the schedule to WAV: click only, and song + click |
| `templates/app.html`, `static/app.js`, `static/app.css` | The one page: upload, lane, song map, practice view, accents, voice cues, live preview |

Markers are the single source of truth for sections: `{time, meter, meter_confidence,
label, voice}`. A section ends where the next marker starts. The earliest marker is the 1.

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

## What changed in Pass 3

- One page: landing pitch, upload, editor, practice and download, no navigation.
- New look (shadow grey, gunmetal, dust grey, digital blue, spring laser).
- Waveform under the beat grid, and a song map with every section as a block.
- The 1: the first marker is now the first downbeat and can be dragged; pickup beats are
  allowed. The analyzer places it on the detected downbeat.
- Count-in length (off / 1 / 2 bars), always ending on the 1.
- Click accents per time signature (loud / normal / soft / off) with presets.
- Voice cues recorded in the browser, played in the preview and mixed into both WAVs.
- Practice view (big readout, next-section countdown), section loop, 60–100% speed.
- Half / double time grid fix.
- Fixture E (two-beat pickup) and tests for the new rules, voice notes and settings.
- Beats now come from madmom's neural beat model (reusing the downbeat model's output, so
  ~1–2 s extra), with librosa as the fallback. It holds syncopated and swung grooves that
  librosa misread: a Latin lo-fi test track went from ~174 BPM (shown as 87) to a steady 127.

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
- **Pickup beats.** The analyzer guesses where the 1 is from accents; on songs without a
  clear kick on 1 it can land a beat or two off. Drag the green 1.
- **Voice cues** are recorded in the browser and need microphone permission. Long cues
  (longer than the bar before the change) overlap the change; the popover warns you.
- **Speed** changes only the preview. Downloads are always at 100%.
- **Meter changes without a harmony or timbre change** are not detected as boundaries. Add
  the marker by hand.
- **Preview latency.** The browser preview schedules clicks against the audio element's
  clock. Bluetooth headphones or unusual audio setups can shift the click against the
  song by a few tens of milliseconds in the preview. The downloaded WAVs are sample-exact.
- Odd meters (5/4, 7/8) are never auto-detected, only 2/4, 3/4, 4/4 and 6/8. Set them by
  hand.
- One process, no queue: one analysis at a time is the expected load.
