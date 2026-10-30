from pathlib import Path
import shutil
import tempfile
import base64

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from analyzer import analyze_song
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
