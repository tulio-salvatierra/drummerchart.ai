"""build_click_schedule rules."""
import numpy as np

from schedule import build_click_schedule

BEATS = [round(2.0 + 0.5 * i, 6) for i in range(64)]  # 120 BPM, first beat at 2.0 s
DURATION = 36.0


def _times(events, kind):
    return [e["time"] for e in events if e["kind"] == kind]


def test_every_beat_gets_exactly_one_event():
    events = build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION)
    on_beats = [e for e in events if e["kind"] in ("beat", "downbeat", "marker")]
    assert [e["time"] for e in on_beats] == BEATS
    assert events == sorted(events, key=lambda e: e["time"])


def test_forced_7_8_accents_every_7_beats():
    markers = [{"time": 2.0, "meter": "4/4"}, {"time": BEATS[16], "meter": "7/8"}]
    events = build_click_schedule(BEATS, markers, DURATION)
    by_time = {e["time"]: e["kind"] for e in events if e["kind"] in ("beat", "downbeat", "marker")}
    assert by_time[BEATS[16]] == "marker"
    for i in range(17, 64):
        expected = "downbeat" if (i - 16) % 7 == 0 else "beat"
        assert by_time[BEATS[i]] == expected, f"beat {i}"
    accents = [i for i in range(16, 64) if by_time[BEATS[i]] in ("downbeat", "marker")]
    assert set(np.diff(accents)) == {7}
    # The first section stays in 4.
    assert [i for i in range(16) if by_time[BEATS[i]] == "downbeat"] == [0, 4, 8, 12]


def test_precue_exactly_one_bar_before_each_marker():
    markers = [
        {"time": 2.0, "meter": "4/4"},
        {"time": BEATS[16], "meter": "3/4"},
        {"time": BEATS[34], "meter": "7/8"},
        {"time": BEATS[48], "meter": "4/4"},
    ]
    events = build_click_schedule(BEATS, markers, DURATION)
    # Bar length comes from the section being left: 4, then 3, then 7 beats.
    assert _times(events, "precue") == [BEATS[16 - 4], BEATS[34 - 3], BEATS[48 - 7]]
    assert _times(events, "marker") == [BEATS[16], BEATS[34], BEATS[48]]


def test_count_in_present_when_there_is_room():
    events = build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION)
    assert np.allclose(_times(events, "count"), [0.0, 0.5, 1.0, 1.5])
    three = build_click_schedule(BEATS, [{"time": 2.0, "meter": "3/4"}], DURATION)
    assert np.allclose(_times(three, "count"), [0.5, 1.0, 1.5])


def test_count_in_skipped_when_it_would_start_before_zero():
    late = [round(1.0 + 0.5 * i, 6) for i in range(32)]
    events = build_click_schedule(late, [{"time": 1.0, "meter": "4/4"}], 20.0)
    assert _times(events, "count") == []


def test_markers_snap_to_beats_and_earliest_is_the_one():
    markers = [{"time": 9.9, "meter": "3/4"}, {"time": 5.0, "meter": "6/8"}]  # unsorted, off-grid
    events = build_click_schedule(BEATS, markers, DURATION)
    by_time = {e["time"]: e["kind"] for e in events if e["kind"] in ("beat", "downbeat", "marker", "soft")}
    assert by_time[5.0] == "downbeat"               # 5.0 s is the one (6/8)
    assert _times(events, "marker") == [10.0]       # 9.9 s snaps to the beat at 10.0 s


def test_pickup_beats_before_the_one_and_count_in_lands_on_it():
    # The one is beat 6 (5.0 s). The 4-beat count-in takes beats 2-5; beats 0-1 are pickup.
    events = build_click_schedule(BEATS, [{"time": BEATS[6], "meter": "4/4"}], DURATION)
    assert _times(events, "count") == BEATS[2:6]
    assert [e["kind"] for e in events if e["time"] in BEATS[:2]] == ["beat", "beat"]
    assert [e for e in events if e["time"] == BEATS[6]][0]["kind"] == "downbeat"


def test_count_in_length_setting():
    m = [{"time": BEATS[8], "meter": "4/4"}]
    assert len(_times(build_click_schedule(BEATS, m, DURATION, {"count_in_bars": 0}), "count")) == 0
    assert len(_times(build_click_schedule(BEATS, m, DURATION, {"count_in_bars": 2}), "count")) == 8
    # Two bars from beat 8 at 0.5 s/beat starts at 2.0 - 0.0 = beat 0: fits exactly.
    two = _times(build_click_schedule(BEATS, m, DURATION, {"count_in_bars": 2}), "count")
    assert np.allclose(two, BEATS[0:8])
    # From the very first beat there is room for one bar (2.0 s), not two.
    first = [{"time": BEATS[0], "meter": "4/4"}]
    assert len(_times(build_click_schedule(BEATS, first, DURATION, {"count_in_bars": 2}), "count")) == 4


def test_custom_accents_per_meter():
    settings = {"accents": {"4": [3, 0, 3, 0]}}  # only 2 and 4, loud
    events = build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION, settings)
    on_grid = [(BEATS.index(e["time"]), e["kind"]) for e in events if e["kind"] != "count"]
    assert on_grid[:4] == [(1, "downbeat"), (3, "downbeat"), (5, "downbeat"), (7, "downbeat")]
    assert 0 not in dict(on_grid) and 2 not in dict(on_grid)
    # Bad accent lists fall back to the default.
    bad = build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION, {"accents": {"4": [0, 9]}})
    assert bad == build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION)


def test_compound_meters_default_to_dotted_quarter_feel():
    events = build_click_schedule(BEATS, [{"time": 2.0, "meter": "6/8"}], DURATION)
    kinds = [e["kind"] for e in events if e["kind"] != "count"][:6]
    assert kinds == ["downbeat", "soft", "soft", "beat", "soft", "soft"]


def test_voice_note_replaces_the_cue_tone():
    markers = [{"time": 2.0, "meter": "4/4", "voice": "a" * 16},
               {"time": BEATS[16], "meter": "4/4", "voice": "b" * 16},
               {"time": BEATS[32], "meter": "4/4"}]
    events = build_click_schedule(BEATS, markers, DURATION)
    voices = [(e["time"], e["note"]) for e in events if e["kind"] == "voice"]
    # First marker's note plays one bar before the one (0.0 s); the second one bar before it.
    assert voices == [(0.0, "a" * 16), (BEATS[12], "b" * 16)]
    assert _times(events, "precue") == [BEATS[28]]


def test_half_and_double_time_grid():
    half = build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION, {"grid": "half"})
    on_grid = [e["time"] for e in half if e["kind"] != "count"]
    assert on_grid == BEATS[::2]
    double = build_click_schedule(BEATS, [{"time": 2.0, "meter": "4/4"}], DURATION, {"grid": "double"})
    assert len([e for e in double if e["kind"] != "count"]) == 2 * len(BEATS) - 1


def test_compound_meters_keep_the_detected_grid():
    for meter, n in (("6/8", 6), ("12/8", 12), ("5/4", 5), ("7/8", 7)):
        events = build_click_schedule(BEATS, [{"time": 2.0, "meter": meter}], DURATION)
        assert [BEATS.index(t) for t in _times(events, "downbeat")] == list(range(0, 64, n))


def test_empty_and_degenerate_inputs():
    assert build_click_schedule([], [], 10.0) == []
    assert len(build_click_schedule([1.0], [], 10.0)) == 1
