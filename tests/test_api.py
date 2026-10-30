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


def test_tempo_review_then_approved_grid():
    import hashlib
    import json
    from unittest.mock import patch
    import app as module
    audio = io.BytesIO()
    sr = 22050
    samples = np.zeros(sr * 12)
    for at in range(sr // 4, len(samples) - 1000, sr // 2):
        t = np.arange(1000) / sr
        samples[at:at+1000] = np.sin(2*np.pi*440*t)*np.exp(-40*t)
    sf.write(audio, samples, sr, format="WAV")
    payload = audio.getvalue()
    client = TestClient(app)
    with patch.object(module, "render_click_track", wraps=module.render_click_track) as renderer:
        tempo = client.post("/tempo", files={"file": ("fixture.mp3",payload)}).json()
        renderer.assert_not_called()
    assert "boundary_times" not in tempo
    assert "click_wav_base64" not in tempo
    review = {"confirmed":True, "source_sha256":hashlib.sha256(payload).hexdigest(),
              "segments":[{"start":.25,"bpm":120},{"start":6.25,"bpm":90}]}
    response=client.post("/tempo/approve",files={"file":("fixture.mp3",payload)},data={"review":json.dumps(review)})
    assert response.status_code == 200, response.text
    result=response.json()
    assert result["beat_times"][:3]==[.25,.75,1.25]
    assert np.isclose(result["beat_times"][13]-result["beat_times"][12], 2/3)
    assert result["tempo_review"]["confirmed"] is True
    assert result["tempo_review"]["corrected_segments"]==review["segments"]
    assert base64.b64decode(result["click_wav_base64"])[:4]==b"RIFF"
