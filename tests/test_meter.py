import numpy as np
import pytest
import soundfile as sf
from tempo import meter_review
from clicktrack import render_click_track

def test_three_four_downbeats_and_pickups():
    beats=np.arange(.25,6,.5).tolist()
    m=meter_review({"numerator":3,"denominator":4,"first_one":1.3},beats,6)
    assert m["first_one"]==1.25
    assert m["downbeat_times"]==[1.25,2.75,4.25,5.75]
    assert m["bpm_unit"]=="quarter"

@pytest.mark.parametrize("meter",[
 {"numerator":7,"denominator":8,"first_one":0},
 {"numerator":3,"denominator":4,"first_one":float("nan")},
 {"numerator":3,"denominator":4,"first_one":10}])
def test_invalid_meter(meter):
    with pytest.raises(ValueError):meter_review(meter,[0,1,2,3],4)

def test_wav_has_three_beat_accent_cycle(tmp_path):
    beats=np.arange(.25,3.5,.5)
    path=render_click_track(beats,np.array([]),4,tmp_path/"meter.wav",downbeat_times=beats[::3])
    y,sr=sf.read(path)
    peaks=[max(abs(y[int(t*sr):int((t+.08)*sr)])) for t in beats]
    assert peaks[0]>peaks[1]*1.2
    assert peaks[3]>peaks[2]*1.2
    assert peaks[6]>peaks[5]*1.2

def test_audition_does_not_detect_sections_and_approval_exports_meter():
    import base64, hashlib, io, json
    from unittest.mock import patch
    from fastapi.testclient import TestClient
    import app
    original=io.BytesIO()
    sf.write(original,np.zeros(22050*6),22050,format="WAV")
    audio=original.getvalue()
    beats=np.arange(.25,6,.5).tolist()
    prediction={"duration":6,"beat_times":beats}
    payload={"confirmed":True,"source_sha256":hashlib.sha256(audio).hexdigest(),
             "meter":{"numerator":3,"denominator":4,"first_one":.25}}
    with patch.object(app,"analyze_song",return_value=prediction) as analyze:
        response=TestClient(app.app).post("/tempo/audition",files={"file":("test.mp3",audio)},data={"review":json.dumps(payload)})
        assert response.status_code==200,response.text
        assert analyze.call_count==1
        assert analyze.call_args.kwargs=={"tempo_only":True}
        data=response.json()
        assert data["approved"] is False
        assert "boundary_times" not in data
        wav,sr=sf.read(io.BytesIO(base64.b64decode(data["audition_wav_base64"])))
        assert wav.shape[1]==2
        assert np.max(abs(wav[:,1]))>0
    with patch.object(app,"analyze_song",side_effect=[prediction,{"duration":6,"beat_times":np.array(beats),"boundary_times":np.array([])}]):
        response=TestClient(app.app).post("/tempo/approve",files={"file":("test.mp3",audio)},data={"review":json.dumps(payload)})
        assert response.status_code==200,response.text
        assert response.json()["meter_review"]["confirmed"] is True
        assert response.json()["meter_review"]["downbeat_times"]==beats[::3]
