"""Click schedule: the single definition of what plays when.

`build_click_schedule` is a pure function. `static/schedule.js` implements the same
rules for the in-browser preview; tests/test_schedule_parity.py keeps the two identical.

Rules
- Markers are snapped to their nearest beat. The first marker always sits on beat 0.
- Bars restart at every marker and use that marker's meter. A meter's numerator is the
  number of detected beats per bar (4/4 = 4, 6/8 = 6, 7/8 = 7, 12/8 = 12): the detected
  beat grid is never re-spaced.
- Every beat emits one event: "marker" on a marker's own beat (after the first),
  "downbeat" on beat 1 of a bar, otherwise "beat".
- "precue" plays exactly one bar before each marker (after the first); the bar length
  comes from the section being left.
- "count": a 1-bar count-in in the first section's meter, extrapolated backwards from
  the first beat intervals. Skipped if it would start before 0 s.
"""
from __future__ import annotations

KIND_ORDER = {"count": 0, "precue": 1, "marker": 2, "downbeat": 3, "beat": 4}

# name: (frequency Hz, length s, amplitude). Mirrored in static/schedule.js (SOUNDS).
SOUNDS = {
    "beat": (1200.0, 0.045, 0.55),
    "downbeat": (1800.0, 0.05, 0.75),
    "count": (1500.0, 0.045, 0.6),
    "precue": (520.0, 0.18, 0.9),
    "marker": (2400.0, 0.06, 0.85),
}
DECAY = 28.0  # envelope = exp(-DECAY * t)


def beats_per_bar(meter) -> int:
    try:
        n = int(str(meter).split("/")[0])
    except (ValueError, IndexError):
        return 4
    return n if 1 <= n <= 32 else 4


def nearest_beat_index(beats: list[float], time: float) -> int:
    lo, hi = 0, len(beats) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if beats[mid] < time:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0 and abs(beats[lo - 1] - time) <= abs(beats[lo] - time):
        return lo - 1
    return lo


def resolve_markers(beats: list[float], markers: list[dict]) -> list[dict]:
    """Markers -> [{index, beats_per_bar}] sorted by beat index, first one at index 0."""
    ordered = sorted(markers, key=lambda m: float(m["time"]))
    resolved: list[dict] = []
    for i, m in enumerate(ordered):
        index = 0 if i == 0 else nearest_beat_index(beats, float(m["time"]))
        entry = {"index": index, "beats_per_bar": beats_per_bar(m.get("meter", "4/4"))}
        if resolved and resolved[-1]["index"] == index:
            resolved[-1] = entry
        else:
            resolved.append(entry)
    if not resolved:
        resolved = [{"index": 0, "beats_per_bar": 4}]
    return resolved


def _median(values: list[float]) -> float:
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def build_click_schedule(beats, markers, duration) -> list[dict]:
    beats = [float(b) for b in beats]
    duration = float(duration)
    if not beats:
        return []
    sections = resolve_markers(beats, markers)
    events: list[dict] = []

    # Count-in.
    if len(beats) >= 2:
        n0 = sections[0]["beats_per_bar"]
        span = min(4, len(beats) - 1)
        interval = _median([beats[i + 1] - beats[i] for i in range(span)])
        if interval > 0 and beats[0] - n0 * interval >= 0:
            for j in range(n0, 0, -1):
                events.append({"time": beats[0] - j * interval, "kind": "count"})

    # One event per beat.
    k = 0
    for i, t in enumerate(beats):
        while k + 1 < len(sections) and sections[k + 1]["index"] <= i:
            k += 1
        sec = sections[k]
        if i == sec["index"] and k > 0:
            kind = "marker"
        elif (i - sec["index"]) % sec["beats_per_bar"] == 0:
            kind = "downbeat"
        else:
            kind = "beat"
        events.append({"time": t, "kind": kind})

    # Pre-cue one bar (of the section being left) before each marker.
    for k in range(1, len(sections)):
        index = sections[k]["index"] - sections[k - 1]["beats_per_bar"]
        if index >= 0:
            events.append({"time": beats[index], "kind": "precue"})

    events = [e for e in events if 0 <= e["time"] <= duration]
    events.sort(key=lambda e: (e["time"], KIND_ORDER[e["kind"]]))
    return events
