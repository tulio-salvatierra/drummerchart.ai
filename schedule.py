"""Click schedule: the single definition of what plays when.

`build_click_schedule` is a pure function. `static/schedule.js` implements the same
rules for the in-browser preview; tests/test_schedule_parity.py keeps the two identical.

Rules
- Beat grid: the detected beats, optionally re-read at half or double time
  (settings["grid"]). The grid is never otherwise re-spaced.
- Markers snap to their nearest beat. The earliest marker is "the one": the first
  downbeat of the song. Beats before it are pickup beats.
- Bars restart at every marker and use that marker's meter. A meter's numerator is the
  number of grid beats per bar (4/4 = 4, 6/8 = 6, 7/8 = 7, 12/8 = 12).
- Accents: each beat of a bar has a level, loud / normal / soft / off, set per
  beats-per-bar in settings["accents"] (defaults: loud on 1, normal elsewhere; 6/8, 9/8
  and 12/8 are felt in dotted quarters). Loud plays "downbeat", normal "beat", soft
  "soft", off plays nothing. A marker's own beat (after the first) plays "marker".
- Count-in: settings["count_in_bars"] bars (0, 1 or 2) in the first section's meter,
  ending exactly on the one. Pickup beats inside it are replaced by count clicks; times
  before the first detected beat are extrapolated from the beat interval at the one.
  Whole bars that would start before 0 s are dropped.
- Section cue: one bar before each marker after the first (bar length of the section
  being left). A marker with a voice note plays "voice" there instead of the "precue"
  tone. A voice note on the first marker plays one bar before the one, if there is room.
"""
from __future__ import annotations

KIND_ORDER = {"count": 0, "precue": 1, "voice": 1, "marker": 2, "downbeat": 3, "beat": 4, "soft": 5}

# name: (frequency Hz, length s, amplitude). Mirrored in static/schedule.js (SOUNDS).
SOUNDS = {
    "beat": (1200.0, 0.045, 0.55),
    "downbeat": (1800.0, 0.05, 0.75),
    "soft": (1200.0, 0.035, 0.28),
    "count": (1500.0, 0.045, 0.6),
    "precue": (520.0, 0.18, 0.9),
    "marker": (2400.0, 0.06, 0.85),
}
DECAY = 28.0  # envelope = exp(-DECAY * t)

LOUD, NORMAL, SOFT, OFF = 0, 1, 2, 3
LEVEL_KIND = {LOUD: "downbeat", NORMAL: "beat", SOFT: "soft"}
DEFAULT_SETTINGS = {"count_in_bars": 1, "grid": "normal", "accents": {}}


def beats_per_bar(meter) -> int:
    try:
        n = int(str(meter).split("/")[0])
    except (ValueError, IndexError):
        return 4
    return n if 1 <= n <= 32 else 4


def default_accents(n: int) -> list[int]:
    if n in (6, 9, 12):  # compound: felt in dotted quarters
        return [LOUD if i == 0 else (NORMAL if i % 3 == 0 else SOFT) for i in range(n)]
    return [LOUD] + [NORMAL] * (n - 1)


def accents_for(settings: dict, n: int) -> list[int]:
    custom = (settings.get("accents") or {}).get(str(n))
    if isinstance(custom, list) and len(custom) == n and all(v in (0, 1, 2, 3) for v in custom):
        return list(custom)
    return default_accents(n)


def apply_grid(beats: list[float], grid: str) -> list[float]:
    if grid == "half":
        return beats[::2]
    if grid == "double":
        out: list[float] = []
        for i, t in enumerate(beats):
            out.append(t)
            if i + 1 < len(beats):
                out.append((t + beats[i + 1]) / 2.0)
        return out
    return list(beats)


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
    """Markers -> [{index, beats_per_bar, voice}] sorted by beat index (one per beat)."""
    ordered = sorted(markers, key=lambda m: float(m["time"]))
    resolved: list[dict] = []
    for m in ordered:
        entry = {
            "index": nearest_beat_index(beats, float(m["time"])),
            "beats_per_bar": beats_per_bar(m.get("meter", "4/4")),
            "voice": m.get("voice") or None,
        }
        if resolved and resolved[-1]["index"] == entry["index"]:
            resolved[-1] = entry
        else:
            resolved.append(entry)
    if not resolved:
        resolved = [{"index": 0, "beats_per_bar": 4, "voice": None}]
    return resolved


def _median(values: list[float]) -> float:
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def _normalize(settings) -> dict:
    s = dict(DEFAULT_SETTINGS)
    if isinstance(settings, dict):
        s.update({k: v for k, v in settings.items() if k in DEFAULT_SETTINGS})
    if s["count_in_bars"] not in (0, 1, 2):
        s["count_in_bars"] = 1
    if s["grid"] not in ("normal", "half", "double"):
        s["grid"] = "normal"
    if not isinstance(s["accents"], dict):
        s["accents"] = {}
    return s


def build_click_schedule(beats, markers, duration, settings=None) -> list[dict]:
    settings = _normalize(settings)
    beats = apply_grid([float(b) for b in beats], settings["grid"])
    duration = float(duration)
    if not beats:
        return []
    sections = resolve_markers(beats, markers)
    one = sections[0]["index"]
    n0 = sections[0]["beats_per_bar"]
    events: list[dict] = []

    # Beat interval at the one, for extrapolating before the first detected beat.
    if len(beats) >= 2:
        start = min(one, len(beats) - 2)
        span = min(4, len(beats) - 1 - start)
        interval = _median([beats[i + 1] - beats[i] for i in range(start, start + span)])
    else:
        interval = 0.0

    def time_at(index: int) -> float:
        return beats[index] if index >= 0 else beats[0] + index * interval

    # Count-in, ending on the one.
    covered: set[int] = set()
    if interval > 0:
        bars = settings["count_in_bars"]
        while bars > 0 and time_at(one - bars * n0) < 0:
            bars -= 1
        for j in range(bars * n0, 0, -1):
            index = one - j
            events.append({"time": time_at(index), "kind": "count"})
            if index >= 0:
                covered.add(index)

    # One event per beat (or none, for an accent set to off).
    accent_cache: dict[int, list[int]] = {}
    k = 0
    for i, t in enumerate(beats):
        if i < one:
            if i not in covered:
                events.append({"time": t, "kind": "beat"})
            continue
        while k + 1 < len(sections) and sections[k + 1]["index"] <= i:
            k += 1
        sec = sections[k]
        if i == sec["index"] and k > 0:
            events.append({"time": t, "kind": "marker"})
            continue
        n = sec["beats_per_bar"]
        if n not in accent_cache:
            accent_cache[n] = accents_for(settings, n)
        level = accent_cache[n][(i - sec["index"]) % n]
        if level != OFF:
            events.append({"time": t, "kind": LEVEL_KIND[level]})

    # Section cues: a voice note if the marker has one, else the cue tone.
    for k in range(len(sections)):
        if k == 0:
            if sections[0]["voice"] and interval > 0:
                t = time_at(one - n0)
                if t >= 0:
                    events.append({"time": t, "kind": "voice", "note": sections[0]["voice"]})
            continue
        index = sections[k]["index"] - sections[k - 1]["beats_per_bar"]
        if index < 0:
            continue
        if sections[k]["voice"]:
            events.append({"time": beats[index], "kind": "voice", "note": sections[k]["voice"]})
        else:
            events.append({"time": beats[index], "kind": "precue"})

    events = [e for e in events if 0 <= e["time"] <= duration]
    events.sort(key=lambda e: (e["time"], KIND_ORDER[e["kind"]]))
    return events
