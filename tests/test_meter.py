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

@pytest.mark.parametrize("numerator,pattern", [(3,"quarter"),(4,"332")])
def test_audition_does_not_detect_sections_and_approval_exports_meter(numerator,pattern):
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
             "meter":{"numerator":numerator,"denominator":4,"first_one":.25,"pattern":pattern}}
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
        assert response.json()["meter_review"]["downbeat_times"]==beats[::numerator]
        assert response.json()["meter_review"]["pattern"]==pattern

def test_eighth_332_variable_timing_and_anchor():
    beats=[0,.5,1,1.6,2.2,2.8,3.4,4,4.6]
    m=meter_review({"numerator":4,"denominator":4,"first_one":.24,"pattern":"332"},beats,5)
    assert m["first_one"]==.25
    assert m["first_one_pulse_index"]==1
    assert m["pulse_times"][:7]==[0,.25,.5,.75,1,1.3,1.6]
    assert m["downbeat_times"]==[.25,2.5]
    assert m["group_accent_times"]==pytest.approx([1,1.9,3.4,4.3])
    assert m["grouping"]==[3,3,2]
    assert m["pulses_per_cycle"]==8
    assert m["pulse_times"][-1]==beats[-1]  # no invented tail beats

def test_eighth_regular_and_invalid_grouping():
    m=meter_review({"numerator":3,"denominator":4,"first_one":0,"pattern":"eighth"},[0,1,2,3,4],5)
    assert m["pulses_per_cycle"]==6
    assert m["downbeat_times"]==[0,3]
    assert m["group_accent_times"]==[]
    with pytest.raises(ValueError):
        meter_review({"numerator":3,"denominator":4,"first_one":0,"pattern":"332"},[0,1,2,3],4)

def test_rendered_332_frequencies(tmp_path):
    beats=np.arange(0,4.5,.5).tolist()
    m=meter_review({"numerator":4,"denominator":4,"first_one":0,"pattern":"332"},beats,5)
    wav=render_click_track(m["pulse_times"],[],5,tmp_path/"332.wav",
                          downbeat_times=m["downbeat_times"],group_accent_times=m["group_accent_times"])
    y,sr=sf.read(wav)
    frequencies=[]
    for t in m["pulse_times"][:8]:
        segment=y[round(t*sr):round(t*sr)+1764]
        frequencies.append(np.fft.rfftfreq(len(segment),1/sr)[np.argmax(abs(np.fft.rfft(segment)))])
    assert frequencies==[1800,1200,1200,1500,1200,1200,1500,1200]
