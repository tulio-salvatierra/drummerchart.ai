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


def test_markers_snap_to_beats_and_first_is_pinned():
    markers = [{"time": 9.9, "meter": "3/4"}, {"time": 5.0, "meter": "6/8"}]  # unsorted, off-grid
    events = build_click_schedule(BEATS, markers, DURATION)
    by_time = {e["time"]: e["kind"] for e in events if e["kind"] in ("beat", "downbeat", "marker")}
    assert by_time[BEATS[0]] == "downbeat"          # earliest marker is pinned to beat 0 (6/8)
    assert by_time[BEATS[6]] == "downbeat"
    assert _times(events, "marker") == [10.0]       # 9.9 s snaps to the beat at 10.0 s


def test_compound_meters_keep_the_detected_grid():
    for meter, n in (("6/8", 6), ("12/8", 12), ("5/4", 5)):
        events = build_click_schedule(BEATS, [{"time": 2.0, "meter": meter}], DURATION)
        assert [BEATS.index(t) for t in _times(events, "downbeat")] == list(range(0, 64, n))


def test_empty_and_degenerate_inputs():
    assert build_click_schedule([], [], 10.0) == []
    assert len(build_click_schedule([1.0], [], 10.0)) == 1
