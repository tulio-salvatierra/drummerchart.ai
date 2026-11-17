"""Analysis accuracy against synthesized songs with known ground truth."""
import numpy as np
import pytest

from schedule import beats_per_bar

NAMES = ["A", "B", "C", "D", "E"]


def _bar_seconds(meter: str, bpm: float) -> float:
    return beats_per_bar(meter) * 60.0 / bpm


def _match_markers(detected: list[dict], true: list[dict], bpm: float):
    """Greedy one-to-one match within one bar. Returns (hits, missed, false)."""
    free = list(range(len(detected)))
    hits, missed = 0, 0
    for tm in true:
        tolerance = _bar_seconds(tm["meter"], bpm)
        best = min(free, key=lambda j: abs(detected[j]["time"] - tm["time"]), default=None)
        if best is not None and abs(detected[best]["time"] - tm["time"]) <= tolerance:
            hits += 1
            free.remove(best)
        else:
            missed += 1
    return hits, missed, len(free)


def _meter_results(detected: list[dict], true: list[dict], duration: float) -> list[bool]:
    """For each true section, is the detected meter at its midpoint correct?"""
    out = []
    for k, tm in enumerate(true):
        end = true[k + 1]["time"] if k + 1 < len(true) else duration
        mid = (tm["time"] + end) / 2.0
        current = [m for m in detected if m["time"] <= mid]
        out.append(bool(current) and current[-1]["meter"] == tm["meter"])
    return out


@pytest.mark.parametrize("name", NAMES)
def test_bpm_within_2(name, analyses, truth):
    assert abs(analyses[name]["result"]["bpm"] - truth[name]["bpm"]) <= 2.0


@pytest.mark.parametrize("name", NAMES)
def test_median_beat_error_under_50ms(name, analyses, truth):
    beats = np.array(analyses[name]["result"]["beats"])
    true_beats = np.array(truth[name]["beats"])
    errors = [np.min(np.abs(true_beats - b)) for b in beats]
    assert np.median(errors) < 0.050
    # And nearly every true beat has a detected beat close by (no half/double-time grid).
    recall = np.mean([np.min(np.abs(beats - t)) < 0.070 for t in true_beats])
    assert recall > 0.95


@pytest.mark.parametrize("name", NAMES)
def test_boundaries_within_one_bar(name, analyses, truth):
    hits, missed, false = _match_markers(analyses[name]["result"]["markers"], truth[name]["markers"], truth[name]["bpm"])
    assert missed == 0, f"missed {missed} of {hits + missed} true boundaries"
    assert false <= 1, f"{false} false markers"


def test_meter_accuracy_at_least_75_percent(analyses, truth):
    results = []
    for name in ["A", "B", "C"]:
        results += _meter_results(analyses[name]["result"]["markers"], truth[name]["markers"], truth[name]["duration"])
    assert len(results) == 11
    assert np.mean(results) >= 0.75, f"meter correct on {sum(results)}/{len(results)} sections"


@pytest.mark.parametrize("name", NAMES)
def test_analysis_shape(name, analyses):
    a = analyses[name]["result"]
    assert set(a) >= {"duration", "bpm", "beats", "downbeats", "markers"}
    first = a["markers"][0]["time"]
    assert first in a["beats"], "the one must sit on a beat"
    assert first == a["downbeats"][0], "the one is the first downbeat"
    assert a["beats"].index(first) < 12, "the one should be within the first bars"
    assert a["beats"] == sorted(a["beats"])
    for m in a["markers"]:
        assert set(m) == {"time", "meter", "meter_confidence", "label"}
        assert m["meter"] in {"2/4", "3/4", "4/4", "6/8"}
        assert 0.0 <= m["meter_confidence"] <= 1.0
        if m["meter_confidence"] < 0.5:
            assert m["meter"] == "4/4", "low-confidence guesses default to 4/4"
    assert set(a["downbeats"]) <= set(a["beats"])


def test_full_length_track_analyzes_under_60s(analyses):
    assert analyses["D"]["seconds"] < 60.0


def test_heuristic_fallback_without_madmom(fixture_dir, truth, monkeypatch):
    """If madmom can't be imported the heuristic path must still produce a usable result."""
    import analyzer
    import meter

    monkeypatch.setattr(meter, "madmom_accents", lambda path, beats: None)
    a = analyzer.analyze_song(fixture_dir / "B.mp3")
    assert a["downbeat_method"] == "heuristic"
    hits, missed, false = _match_markers(a["markers"], truth["B"]["markers"], truth["B"]["bpm"])
    assert missed == 0 and false <= 1
    assert sum(_meter_results(a["markers"], truth["B"]["markers"], truth["B"]["duration"])) >= 2


def test_score_section_separates_meters():
    import meter

    rng = np.random.default_rng(0)
    for period in (2, 3, 4, 6):
        accent = rng.uniform(0.0, 0.15, 96)
        accent[1::period] += 1.0
        result = meter.score_section(accent)
        assert (result["period"], result["phase"]) == (period, 1)
        assert result["confidence"] >= 0.5
    flat = meter.score_section(rng.uniform(0.0, 1.0, 96))
    assert flat["confidence"] < 0.5


def test_the_one_is_found_after_a_pickup(analyses, truth):
    """Fixture E starts with two pickup beats: the first marker must be the real downbeat."""
    a, t = analyses["E"]["result"], truth["E"]
    assert t["beats"][0] < t["markers"][0]["time"]
    assert abs(a["markers"][0]["time"] - t["markers"][0]["time"]) < 0.070
    assert a["beats"][0] < a["markers"][0]["time"], "pickup beats stay on the grid"
