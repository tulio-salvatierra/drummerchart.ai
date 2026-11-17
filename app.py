"""Drummer Chart AI — Pass 2. Upload -> analyze once -> edit markers -> render."""
from __future__ import annotations

import json
import re
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
MAX_MARKERS = 300


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
    return templates.TemplateResponse(request=request, name="index.html")


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
    path = _job_or_404(job_id)
    analysis = _load_analysis(path)
    return templates.TemplateResponse(
        request=request,
        name="editor.html",
        context={"job_id": job_id, "filename": analysis.get("filename", "song.mp3"), "meters": METERS},
    )


@app.get("/job/{job_id}/analysis")
def get_analysis(job_id: str):
    return JSONResponse(_load_analysis(_job_or_404(job_id)))


@app.get("/job/{job_id}/audio")
def get_audio(job_id: str):
    return FileResponse(_job_or_404(job_id) / "input.mp3", media_type="audio/mpeg")


def _clean_markers(raw, duration: float) -> list[dict]:
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
        cleaned.append({"time": float(time_s), "meter": meter, "label": str(item.get("label", ""))[:40]})
    return sorted(cleaned, key=lambda m: m["time"])


@app.post("/render/{job_id}")
def render(job_id: str, payload: dict = Body(...)):
    """Render both WAVs from the saved beats + the markers in the request. No analysis."""
    path = _job_or_404(job_id)
    analysis = _load_analysis(path)
    markers = _clean_markers(payload.get("markers"), analysis["duration"])
    try:
        clicktrack.render_job(
            beats=analysis["beats"],
            markers=markers,
            duration=analysis["duration"],
            song_path=path / "input.mp3",
            click_path=path / "click.wav",
            mix_path=path / "mix.wav",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Rendering failed: {exc}") from exc
    (path / "markers.json").write_text(json.dumps(markers))
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
