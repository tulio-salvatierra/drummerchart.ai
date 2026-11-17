"""Drummer Chart AI — Pass 2. Upload -> analyze once -> edit markers -> render."""
from __future__ import annotations

import json
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import analyzer
import clicktrack
import jobs

BASE_DIR = Path(__file__).resolve().parent
METERS = ["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "12/8"]
METER_RE = re.compile(r"^\d{1,2}/\d{1,2}$")
NOTE_RE = re.compile(r"^[0-9a-f]{16}$")
MAX_MARKERS = 300
MAX_VOICE_BYTES = 1024 * 1024
MAX_VOICE_SECONDS = 6.0
MAX_VOICE_NOTES = 100


@asynccontextmanager
async def lifespan(_: FastAPI):
    jobs.cleanup_old_jobs()
    yield


templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app = FastAPI(title="Drummer Chart AI — Pass 2", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def _job_or_404(job_id: str) -> Path:
    path = jobs.job_path(job_id)
    if path is None or not (path / "analysis.json").is_file():
        raise HTTPException(status_code=404, detail="Job not found. It may have expired (jobs are kept for 2 hours).")
    return path


def _load_analysis(path: Path) -> dict:
    return json.loads((path / "analysis.json").read_text())


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(request=request, name="app.html", context={"job_id": "", "meters": METERS})


@app.post("/analyze")
def analyze(file: UploadFile = File(...)):
    filename = Path(file.filename or "song.mp3").name
    if Path(filename).suffix.lower() != ".mp3":
        raise HTTPException(status_code=400, detail="Only MP3 files are accepted.")

    jobs.cleanup_old_jobs()
    job_id, path = jobs.create_job()
    try:
        input_path = path / "input.mp3"
        size = 0
        with input_path.open("wb") as target:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > jobs.MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="File is too large. The limit is 20 MB.")
                target.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The uploaded file is empty.")

        try:
            seconds = sf.info(str(input_path)).duration
        except Exception as exc:
            raise HTTPException(status_code=422, detail="Could not read this file as MP3 audio.") from exc
        if seconds > jobs.MAX_DURATION_SECONDS:
            raise HTTPException(status_code=413, detail="Song is too long. The limit is 10 minutes.")

        try:
            analysis = analyzer.analyze_song(input_path)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not analyze this audio: {exc}") from exc

        analysis = {"job_id": job_id, "filename": filename, **analysis}
        (path / "analysis.json").write_text(json.dumps(analysis))
    except Exception:
        jobs.delete_job(job_id)
        raise
    return RedirectResponse(url=f"/job/{job_id}", status_code=303)


@app.get("/job/{job_id}")
def editor(request: Request, job_id: str):
    _job_or_404(job_id)
    return templates.TemplateResponse(request=request, name="app.html", context={"job_id": job_id, "meters": METERS})


@app.get("/job/{job_id}/analysis")
def get_analysis(job_id: str):
    return JSONResponse(_load_analysis(_job_or_404(job_id)))


@app.get("/job/{job_id}/audio")
def get_audio(job_id: str):
    return FileResponse(_job_or_404(job_id) / "input.mp3", media_type="audio/mpeg")


@app.post("/job/{job_id}/voice")
def upload_voice(job_id: str, file: UploadFile = File(...)):
    """Save a recorded voice note (16-bit WAV, made in the browser). Returns its id."""
    path = _job_or_404(job_id)
    folder = path / "voice"
    folder.mkdir(exist_ok=True)
    if len(list(folder.glob("*.wav"))) >= MAX_VOICE_NOTES:
        raise HTTPException(status_code=413, detail=f"Too many voice notes for this song (limit {MAX_VOICE_NOTES}).")
    data = file.file.read(MAX_VOICE_BYTES + 1)
    if len(data) > MAX_VOICE_BYTES:
        raise HTTPException(status_code=413, detail="Voice note is too large. Keep it under 6 seconds.")
    note_id = secrets.token_hex(8)
    target = folder / f"{note_id}.wav"
    target.write_bytes(data)
    try:
        info = sf.info(str(target))
        if info.format != "WAV" or info.duration <= 0:
            raise ValueError("not a WAV")
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Could not read the voice note as WAV audio.") from exc
    if info.duration > MAX_VOICE_SECONDS:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="Voice note is too long. Keep it under 6 seconds.")
    return {"id": note_id, "duration": round(info.duration, 3), "url": f"/job/{job_id}/voice/{note_id}"}


@app.get("/job/{job_id}/voice/{note_id}")
def get_voice(job_id: str, note_id: str):
    path = _job_or_404(job_id)
    target = path / "voice" / f"{note_id}.wav"
    if not NOTE_RE.fullmatch(note_id) or not target.is_file():
        raise HTTPException(status_code=404, detail="Voice note not found.")
    return FileResponse(target, media_type="audio/wav")


def _clean_settings(raw) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="Settings must be an object.")
    out: dict = {}
    if "count_in_bars" in raw:
        if raw["count_in_bars"] not in (0, 1, 2) or isinstance(raw["count_in_bars"], bool):
            raise HTTPException(status_code=422, detail="Count-in must be 0, 1 or 2 bars.")
        out["count_in_bars"] = raw["count_in_bars"]
    if "grid" in raw:
        if raw["grid"] not in ("normal", "half", "double"):
            raise HTTPException(status_code=422, detail="Grid must be normal, half or double.")
        out["grid"] = raw["grid"]
    accents = raw.get("accents", {})
    if not isinstance(accents, dict) or len(accents) > 32:
        raise HTTPException(status_code=422, detail="Accents must map beats-per-bar to levels.")
    clean_accents = {}
    for key, levels in accents.items():
        if not re.fullmatch(r"\d{1,2}", str(key)) or not (1 <= int(key) <= 32):
            raise HTTPException(status_code=422, detail="Accents must map beats-per-bar to levels.")
        if (not isinstance(levels, list) or len(levels) != int(key)
                or any(isinstance(v, bool) or v not in (0, 1, 2, 3) for v in levels)):
            raise HTTPException(status_code=422, detail=f"Accent levels for {key} beats must be {key} values from 0 to 3.")
        clean_accents[str(int(key))] = list(levels)
    out["accents"] = clean_accents
    return out


def _clean_markers(raw, duration: float, voice_dir: Path | None = None) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=422, detail="Send a non-empty list of markers.")
    if len(raw) > MAX_MARKERS:
        raise HTTPException(status_code=422, detail=f"Too many markers (limit {MAX_MARKERS}).")
    cleaned = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=422, detail="Each marker must be an object.")
        time_s, meter = item.get("time"), item.get("meter", "4/4")
        if isinstance(time_s, bool) or not isinstance(time_s, (int, float)) or not (0 <= time_s <= duration + 1):
            raise HTTPException(status_code=422, detail="Marker time is outside the song.")
        if not isinstance(meter, str) or not METER_RE.fullmatch(meter) or not (1 <= int(meter.split("/")[0]) <= 32):
            raise HTTPException(status_code=422, detail=f"Unsupported meter: {meter!r}.")
        voice = item.get("voice") or None
        if voice is not None:
            if not isinstance(voice, str) or not NOTE_RE.fullmatch(voice):
                raise HTTPException(status_code=422, detail="Bad voice note id.")
            if voice_dir is None or not (voice_dir / f"{voice}.wav").is_file():
                raise HTTPException(status_code=422, detail="A voice note is missing. Record it again.")
        cleaned.append({"time": float(time_s), "meter": meter, "label": str(item.get("label", ""))[:40], "voice": voice})
    return sorted(cleaned, key=lambda m: m["time"])


@app.post("/render/{job_id}")
def render(job_id: str, payload: dict = Body(...)):
    """Render both WAVs from the saved beats + the markers in the request. No analysis."""
    path = _job_or_404(job_id)
    analysis = _load_analysis(path)
    voice_dir = path / "voice"
    markers = _clean_markers(payload.get("markers"), analysis["duration"], voice_dir)
    settings = _clean_settings(payload.get("settings"))
    voices = {m["voice"]: voice_dir / f"{m['voice']}.wav" for m in markers if m["voice"]}
    try:
        clicktrack.render_job(
            beats=analysis["beats"],
            markers=markers,
            duration=analysis["duration"],
            song_path=path / "input.mp3",
            click_path=path / "click.wav",
            mix_path=path / "mix.wav",
            settings=settings,
            voices=voices,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Rendering failed: {exc}") from exc
    (path / "markers.json").write_text(json.dumps({"markers": markers, "settings": settings}))
    return {"click": f"/job/{job_id}/download/click", "mix": f"/job/{job_id}/download/mix"}


@app.get("/job/{job_id}/download/{kind}")
def download(job_id: str, kind: str):
    path = _job_or_404(job_id)
    if kind not in ("click", "mix"):
        raise HTTPException(status_code=404, detail="Unknown download.")
    target = path / f"{kind}.wav"
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not rendered yet. Press Download in the editor first.")
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", Path(_load_analysis(path).get("filename", "song")).stem) or "song"
    suffix = "clicktrack" if kind == "click" else "with_click"
    return FileResponse(target, media_type="audio/wav", filename=f"{stem}_{suffix}.wav")
