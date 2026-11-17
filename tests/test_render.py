"""Rendered WAVs: full length, right content, no clipping."""
import numpy as np
import pytest
import soundfile as sf

import clicktrack
from schedule import build_click_schedule


@pytest.fixture(scope="module")
def rendered(tmp_path_factory, fixture_dir, truth):
    out = {}
    for name in ["B", "D"]:
        folder = tmp_path_factory.mktemp(f"render_{name}")
        t = truth[name]
        markers = [dict(m) for m in t["markers"]]
        markers[-1]["meter"] = "7/8"
        clicktrack.render_job(t["beats"], markers, t["duration"], fixture_dir / f"{name}.mp3",
                              folder / "click.wav", folder / "mix.wav")
        out[name] = (folder, markers)
    return out


@pytest.mark.parametrize("name", ["B", "D"])
@pytest.mark.parametrize("kind", ["click", "mix"])
def test_wav_covers_the_full_song(name, kind, rendered, truth):
    info = sf.info(str(rendered[name][0] / f"{kind}.wav"))
    assert info.samplerate == 44100
    assert abs(info.duration - truth[name]["duration"]) <= 0.5


@pytest.mark.parametrize("name", ["B", "D"])
def test_mix_does_not_clip(name, rendered):
    data, _ = sf.read(str(rendered[name][0] / "mix.wav"), dtype="float32")
    assert float(np.max(np.abs(data))) <= 1.0
    assert np.mean(np.abs(data) >= 0.999) == 0.0, "samples pinned at full scale"


def test_mix_float_peak_before_writing():
    click = clicktrack.render_click([{"time": 0.1 * i, "kind": "precue"} for i in range(50)], 6.0)
    loud = np.ones((len(click), 2), dtype=np.float32)
    assert float(np.max(np.abs(clicktrack.render_mix(click, loud)))) <= 1.0
    assert float(np.max(np.abs(click))) <= 1.0


def test_click_wav_has_a_click_at_every_scheduled_event(rendered, truth):
    folder, markers = rendered["B"]
    t = truth["B"]
    data, sr = sf.read(str(folder / "click.wav"), dtype="float32")
    events = build_click_schedule(t["beats"], markers, t["duration"])
    assert len(events) > len(t["beats"])
    for event in events:
        start = int(round(event["time"] * sr))
        assert float(np.max(np.abs(data[start : start + 400]))) > 0.1, event
    # ...and silence between clicks (late in the gap before the next beat).
    gap = int(round((t["beats"][0] + 0.5) * sr))
    assert float(np.max(np.abs(data[gap : gap + 400]))) < 0.01


def test_mix_contains_the_song_and_the_click(rendered, fixture_dir):
    folder, _ = rendered["B"]
    click, _ = sf.read(str(folder / "click.wav"), dtype="float32")
    mix, _ = sf.read(str(folder / "mix.wav"), dtype="float32", always_2d=True)
    song = clicktrack._load_song(fixture_dir / "B.mp3")
    n = min(len(mix), len(song))
    assert np.corrcoef(mix[:n, 0], song[:n, 0])[0, 1] > 0.5, "song missing from the mix"
    assert np.corrcoef(mix[:n, 0], click[:n])[0, 1] > 0.2, "click missing from the mix"
