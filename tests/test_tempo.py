import io
from unittest.mock import patch
import numpy as np
import pytest
from fastapi.testclient import TestClient
from app import app
from tempo import reviewed_grid


def test_piecewise_grid_and_phase():
    assert reviewed_grid([{"start": .25, "bpm": 120}, {"start": 2.25, "bpm": 60}], 5) == [.25,.75,1.25,1.75,2.25,3.25,4.25]


@pytest.mark.parametrize("segments", [[], [{"start":0,"bpm":0}], [{"start":float("nan"),"bpm":120}], [{"start":2,"bpm":120},{"start":1,"bpm":120}], [{"start":0,"bpm":500}]])
def test_invalid_maps(segments):
    with pytest.raises(ValueError):
        reviewed_grid(segments, 10)


def test_tempo_stage_never_detects_sections_or_renders():
    from analyzer import analyze_song
    with patch("analyzer.librosa.load", return_value=(np.ones(22050*8),22050)), patch("analyzer.librosa.onset.onset_strength",return_value=np.ones(100)), patch("analyzer.librosa.feature.tempo",return_value=np.array([120])), patch("analyzer.librosa.beat.beat_track",return_value=(120,np.arange(10,310,20))), patch("analyzer._detect_section_boundaries") as sections:
        result=analyze_song("unused",tempo_only=True)
        assert "boundary_times" not in result
        sections.assert_not_called()


def test_approval_required_and_audio_bound():
    client=TestClient(app)
    for review in ['{"confirmed": false}', '{"confirmed":true,"source_sha256":"wrong"}']:
        response=client.post("/tempo/approve",files={"file":("fixture.mp3",b"fixture")},data={"review":review})
        assert response.status_code==422
