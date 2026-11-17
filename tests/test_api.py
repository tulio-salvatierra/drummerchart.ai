"""End-to-end API flow through FastAPI's TestClient."""
import json
import os
import subprocess
import time

import pytest
import soundfile as sf
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    os.environ["DRUMMERCHART_JOBS_DIR"] = str(tmp_path_factory.mktemp("jobs"))
    import app as app_module

    with TestClient(app_module.app, follow_redirects=False) as c:
        yield c
    os.environ.pop("DRUMMERCHART_JOBS_DIR", None)


@pytest.fixture(scope="module")
def job(client, fixture_dir):
    with open(fixture_dir / "B.mp3", "rb") as f:
        res = client.post("/analyze", files={"file": ("B.mp3", f, "audio/mpeg")})
    assert res.status_code == 303, res.text
    location = res.headers["location"]
    assert location.startswith("/job/")
    return location.rsplit("/", 1)[1]


def _jobs_dir():
    from pathlib import Path

    return Path(os.environ["DRUMMERCHART_JOBS_DIR"])


def test_upload_saves_analysis_json(client, job):
    saved = json.loads((_jobs_dir() / job / "analysis.json").read_text())
    assert saved["job_id"] == job
    assert {"duration", "bpm", "beats", "downbeats", "markers"} <= set(saved)
    assert (_jobs_dir() / job / "input.mp3").is_file()
    assert client.get(f"/job/{job}/analysis").json() == saved


def test_editor_page_and_audio(client, job):
    page = client.get(f"/job/{job}")
    assert page.status_code == 200
    assert "/static/app.js" in page.text and job in page.text
    audio = client.get(f"/job/{job}/audio")
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg"
    assert client.get("/static/schedule.js").status_code == 200
    home = client.get("/")
    assert home.status_code == 200 and 'id="file-input"' in home.text


def test_render_with_edited_markers_does_not_reanalyze(client, job, monkeypatch, tmp_path):
    import analyzer

    calls = []
    monkeypatch.setattr(analyzer, "analyze_song", lambda *a, **k: calls.append(a) or pytest.fail("render re-ran the analysis"))
    analysis = client.get(f"/job/{job}/analysis").json()
    markers = [{"time": m["time"], "meter": m["meter"], "label": m["label"]} for m in analysis["markers"]]
    markers[-1]["meter"] = "7/8"
    markers.append({"time": analysis["beats"][20], "meter": "5/4", "label": "Bridge"})

    assert client.get(f"/job/{job}/download/click").status_code == 404  # nothing rendered yet
    res = client.post(f"/render/{job}", json={"markers": markers})
    assert res.status_code == 200, res.text
    assert calls == []
    urls = res.json()
    assert set(urls) == {"click", "mix"}
    for kind in ("click", "mix"):
        download = client.get(urls[kind])
        assert download.status_code == 200
        assert download.headers["content-type"] == "audio/wav"
        assert "attachment" in download.headers["content-disposition"]
        target = tmp_path / f"{kind}.wav"
        target.write_bytes(download.content)
        assert abs(sf.info(str(target)).duration - analysis["duration"]) <= 0.5


@pytest.mark.parametrize("bad", ["nope", "0" * 31, "g" * 32, "0" * 32, "..%2F..%2Fetc", "A" * 32])
def test_bad_job_id_is_404(client, bad):
    assert client.get(f"/job/{bad}").status_code == 404
    assert client.get(f"/job/{bad}/analysis").status_code == 404
    assert client.get(f"/job/{bad}/audio").status_code == 404
    assert client.get(f"/job/{bad}/download/click").status_code == 404
    assert client.post(f"/render/{bad}", json={"markers": [{"time": 0, "meter": "4/4"}]}).status_code == 404


def test_render_rejects_bad_markers(client, job):
    for payload in ({"markers": []}, {"markers": [{"time": -5, "meter": "4/4"}]},
                    {"markers": [{"time": 1, "meter": "../x"}]}, {"markers": "x"}, {}):
        assert client.post(f"/render/{job}", json=payload).status_code == 422


def test_oversize_file_is_rejected_with_a_message(client):
    big = b"\xff\xfb\x90\x00" * (21 * 1024 * 1024 // 4)
    before = set(_jobs_dir().iterdir())
    res = client.post("/analyze", files={"file": ("big.mp3", big, "audio/mpeg")})
    assert res.status_code == 413
    assert "20 MB" in res.json()["detail"]
    assert set(_jobs_dir().iterdir()) == before, "failed uploads must not leave a job folder behind"


def test_too_long_song_is_rejected_with_a_message(client, tmp_path):
    long_mp3 = tmp_path / "long.mp3"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=22050",
                    "-t", "605", "-codec:a", "libmp3lame", "-b:a", "32k", str(long_mp3)], check=True)
    with open(long_mp3, "rb") as f:
        res = client.post("/analyze", files={"file": ("long.mp3", f, "audio/mpeg")})
    assert res.status_code == 413
    assert "10 minutes" in res.json()["detail"]


def test_only_mp3_is_accepted(client):
    res = client.post("/analyze", files={"file": ("song.wav", b"RIFF0000WAVE", "audio/wav")})
    assert res.status_code == 400 and "MP3" in res.json()["detail"]
    res = client.post("/analyze", files={"file": ("fake.mp3", b"this is not audio", "audio/mpeg")})
    assert res.status_code == 422 and res.json()["detail"]


def test_old_jobs_are_cleaned_up(client):
    import jobs

    old_id, old_path = jobs.create_job()
    fresh_id, fresh_path = jobs.create_job()
    three_hours_ago = time.time() - 3 * 3600
    os.utime(old_path, (three_hours_ago, three_hours_ago))
    assert jobs.cleanup_old_jobs() == 1
    assert not old_path.exists() and fresh_path.exists()
    jobs.delete_job(fresh_id)


def _wav_bytes(seconds: float, tmp_path, name="note.wav", sr=44100) -> bytes:
    import numpy as np

    t = np.arange(int(seconds * sr)) / sr
    target = tmp_path / name
    sf.write(str(target), (0.5 * np.sin(2 * np.pi * 300 * t)).astype("float32"), sr, subtype="PCM_16")
    return target.read_bytes()


def test_voice_note_upload_and_render(client, job, tmp_path):
    import numpy as np

    res = client.post(f"/job/{job}/voice", files={"file": ("note.wav", _wav_bytes(1.2, tmp_path), "audio/wav")})
    assert res.status_code == 200, res.text
    note = res.json()
    assert len(note["id"]) == 16 and abs(note["duration"] - 1.2) < 0.01
    assert client.get(note["url"]).status_code == 200

    analysis = client.get(f"/job/{job}/analysis").json()
    markers = [{"time": m["time"], "meter": m["meter"]} for m in analysis["markers"]]
    markers[1]["voice"] = note["id"]
    settings = {"count_in_bars": 2, "grid": "normal", "accents": {"4": [3, 0, 3, 0]}}
    res = client.post(f"/render/{job}", json={"markers": markers, "settings": settings})
    assert res.status_code == 200, res.text

    from schedule import build_click_schedule

    events = build_click_schedule(analysis["beats"], markers, analysis["duration"], settings)
    voice_event = [e for e in events if e["kind"] == "voice"][0]
    click = tmp_path / "click.wav"
    click.write_bytes(client.get(res.json()["click"]).content)
    data, sr = sf.read(str(click), dtype="float32")
    start = int(voice_event["time"] * sr)
    window = data[start + 2000 : start + 2000 + int(0.5 * sr)]
    # 300 Hz voice note present (not the 520 Hz cue tone)
    spectrum = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(window), 1 / sr)
    assert abs(freqs[np.argmax(spectrum)] - 300) < 15
    saved = json.loads((_jobs_dir() / job / "markers.json").read_text())
    assert saved["settings"]["count_in_bars"] == 2


def test_voice_note_validation(client, job, tmp_path):
    assert client.post(f"/job/{job}/voice", files={"file": ("x.wav", b"not audio", "audio/wav")}).status_code == 422
    long = client.post(f"/job/{job}/voice", files={"file": ("x.wav", _wav_bytes(7.0, tmp_path, "long.wav", 8000), "audio/wav")})
    assert long.status_code == 413 and "6 seconds" in long.json()["detail"]
    assert client.get(f"/job/{job}/voice/../../analysis").status_code == 404
    assert client.get(f"/job/{job}/voice/{'0' * 16}").status_code == 404
    analysis = client.get(f"/job/{job}/analysis").json()
    marker = {"time": analysis["markers"][0]["time"], "meter": "4/4"}
    for bad in ({"voice": "0" * 16}, {"voice": "../x"}):
        assert client.post(f"/render/{job}", json={"markers": [dict(marker, **bad)]}).status_code == 422
    for settings in ({"count_in_bars": 3}, {"grid": "triple"}, {"accents": {"4": [0, 1]}},
                     {"accents": {"x": [0]}}, {"accents": {"4": [0, 1, 2, 9]}}, "nope"):
        res = client.post(f"/render/{job}", json={"markers": [marker], "settings": settings})
        assert res.status_code == 422, settings
