import base64
import io
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from app import app

def test_real_audio_upload_and_legacy_wav():
    sr = 22050
    audio = np.zeros(sr * 16)
    for start in np.arange(.25, 16, .5):
        at = int(start * sr)
        t = np.arange(1000) / sr
        audio[at:at+1000] += .8 * np.sin(2*np.pi*440*t) * np.exp(-40*t)
    fixture = io.BytesIO()
    # libsndfile decodes by header; synthetic WAV payload exercises the analyzer
    # through the MP3-named upload contract, not an MP3 codec compatibility test.
    sf.write(fixture, audio, sr, format="WAV")
    client = TestClient(app)
    response = client.post("/analyze/result", files={"file": ("fixture.mp3", fixture.getvalue(), "audio/mpeg")})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["duration"] == 16
    assert len(data["beat_times"]) >= 4
    wav, rate = sf.read(io.BytesIO(base64.b64decode(data["click_wav_base64"])))
    assert rate == 44100 and len(wav) >= 16 * rate
    legacy = client.post("/analyze", files={"file": ("fixture.mp3", fixture.getvalue(), "audio/mpeg")})
    assert legacy.status_code == 200
    assert legacy.content[:4] == b"RIFF"
    assert client.get("/").status_code == 200
    assert client.get("/static/editor.mjs").status_code == 200
    assert client.post("/analyze/result", files={"file": ("bad.txt", b"bad")}).status_code == 400
    assert client.post("/analyze/result", files={"file": ("bad.mp3", b"bad")}).status_code == 422
