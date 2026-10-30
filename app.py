from pathlib import Path
import shutil
import tempfile
import base64
import json
import hashlib

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from analyzer import analyze_song
from tempo import reviewed_grid, meter_review
from clicktrack import render_click_track

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app = FastAPI(title="Drummer Chart AI — Pass 2B draft")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.post("/analyze")
def analyze(file: UploadFile = File(...)):
    filename = file.filename or "song.mp3"
    if Path(filename).suffix.lower() != ".mp3":
        raise HTTPException(status_code=400, detail="Pass 1 accepts MP3 files only.")

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "input.mp3"
        with input_path.open("wb") as target:
            shutil.copyfileobj(file.file, target)

        try:
            analysis = analyze_song(input_path)
            output_path = OUTPUT_DIR / f"{Path(filename).stem}_clicktrack.wav"
            render_click_track(
                beat_times=analysis["beat_times"],
                boundary_times=analysis["boundary_times"],
                duration=analysis["duration"],
                output_path=output_path,
            )
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not analyze this audio: {exc}") from exc

    return FileResponse(
        path=output_path,
        media_type="audio/wav",
        filename=output_path.name,
    )


@app.post("/analyze/result")
def analyze_result(file: UploadFile = File(...)):
    """Self-contained draft result; legacy /analyze remains a WAV download."""
    if Path(file.filename or "").suffix.lower() != ".mp3":
        raise HTTPException(400, "Upload an MP3.")
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "input.mp3"
        source.write_bytes(file.file.read())
        try:
            analysis = analyze_song(source)
            wav = render_click_track(
                analysis["beat_times"], analysis["boundary_times"],
                analysis["duration"], Path(directory) / "click.wav")
            return {
                "schema_version": 1,
                "analysis_version": "pass1-boundaries",
                "source_name": Path(file.filename).name,
                "duration": analysis["duration"],
                "beat_times": analysis["beat_times"].tolist(),
                "boundary_times": analysis["boundary_times"].tolist(),
                "click_wav_base64": base64.b64encode(wav.read_bytes()).decode("ascii"),
            }
        except Exception as exc:
            raise HTTPException(422, f"Could not analyze this audio: {exc}") from exc


@app.post("/tempo")
def tempo_result(file: UploadFile = File(...)):
    if Path(file.filename or "").suffix.lower() != ".mp3":
        raise HTTPException(400, "Upload an MP3.")
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "input.mp3"
        audio = file.file.read()
        source.write_bytes(audio)
        try:
            data = analyze_song(source, tempo_only=True)
            return {**data, "source_name": Path(file.filename).name,
                    "source_sha256": hashlib.sha256(audio).hexdigest()}
        except Exception as exc:
            raise HTTPException(422, str(exc)) from exc


@app.post("/tempo/approve")
def approve_tempo(file: UploadFile = File(...), review: str = Form(...), audition: bool = False):
    if Path(file.filename or "").suffix.lower() != ".mp3":
        raise HTTPException(400, "Upload an MP3.")
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "input.mp3"
        audio = file.file.read()
        source.write_bytes(audio)
        try:
            payload = json.loads(review)
            if not audition and payload.get("confirmed") is not True:
                raise ValueError("Confirm the tempo map before continuing.")
            if payload.get("source_sha256") != hashlib.sha256(audio).hexdigest():
                raise ValueError("Audio changed; analyze its tempo again.")
            prediction = analyze_song(source, tempo_only=True)
            segments = payload.get("segments")
            beats = reviewed_grid(segments, prediction["duration"]) if segments is not None else prediction["beat_times"]
            meter = meter_review(payload["meter"], beats, prediction["duration"]) if payload.get("meter") else None
            if audition:
                if meter is None:
                    raise ValueError("Choose a meter and first ONE to audition.")
                import librosa
                import numpy as np
                import soundfile as sf
                wav = render_click_track(np.asarray(beats), np.array([]), prediction["duration"],
                                         Path(directory) / "click.wav", downbeat_times=meter["downbeat_times"])
                click, sr = sf.read(wav)
                original, _ = librosa.load(source, sr=sr, mono=True)
                mix = np.zeros((len(click), 2))
                mix[:len(original), 0] = original * .7
                mix[:, 1] = click * .6
                sf.write(Path(directory) / "audition.wav", mix, sr, subtype="PCM_16")
                return {"meter_review": meter, "beat_times": beats, "approved": False,
                        "audition_wav_base64": base64.b64encode((Path(directory) / "audition.wav").read_bytes()).decode("ascii")}
            analysis = analyze_song(source, reviewed_beats=beats)
            wav = render_click_track(analysis["beat_times"], analysis["boundary_times"],
                                     analysis["duration"], Path(directory) / "click.wav",
                                     downbeat_times=meter["downbeat_times"] if meter else None)
            return {"schema_version": 2, "analysis_version": "tempo-review-v1",
                    "source_name": Path(file.filename).name,
                    "source_sha256": payload["source_sha256"],
                    "duration": analysis["duration"], "beat_times": beats,
                    "boundary_times": analysis["boundary_times"].tolist(),
                    "meter_review": {**meter, "confirmed": True} if meter else None,
                    "tempo_review": {"confirmed": True, "predicted": prediction,
                                     "corrected_segments": segments,
                                     "mode": "piecewise-grid" if segments is not None else "detected-beats"},
                    "click_wav_base64": base64.b64encode(wav.read_bytes()).decode("ascii")}
        except Exception as exc:
            raise HTTPException(422, str(exc)) from exc


@app.post("/tempo/audition")
def audition_meter(file: UploadFile = File(...), review: str = Form(...)):
    """Diagnostic mix only: never detects sections or approves a map."""
    return approve_tempo(file=file, review=review, audition=True)
