"""Validated piecewise tempo maps; segment starts are explicit beat anchors."""
import math
import numpy as np


def reviewed_grid(segments, duration):
    if not isinstance(segments, list) or not 1 <= len(segments) <= 500:
        raise ValueError("Provide 1–500 tempo segments.")
    anchors = []
    for segment in segments:
        start, bpm = float(segment["start"]), float(segment["bpm"])
        if not math.isfinite(start) or not math.isfinite(bpm):
            raise ValueError("Tempo values must be finite.")
        if not 0 <= start < duration or not 20 <= bpm <= 400:
            raise ValueError("Anchors must be inside the song; BPM must be 20–400.")
        if anchors and start <= anchors[-1][0]:
            raise ValueError("Tempo anchors must be strictly increasing.")
        anchors.append((start, bpm))
    beats = []
    for i, (start, bpm) in enumerate(anchors):
        end = anchors[i+1][0] if i+1 < len(anchors) else duration
        beats.extend(np.arange(start, end - 1e-8, 60 / bpm).tolist())
    if len(beats) < 4:
        raise ValueError("The map must contain at least four beats.")
    return beats


def meter_review(meter, beats, duration):
    """Quarter-note BPM with optional eighth-note pulses and 3+3+2 grouping."""
    if not isinstance(meter, dict):
        raise ValueError("Choose a meter and first ONE.")
    numerator = meter.get("numerator")
    if type(numerator) is not int or numerator not in (2, 3, 4):
        raise ValueError("This draft supports 2/4, 3/4 and 4/4.")
    if meter.get("denominator") != 4:
        raise ValueError("BPM is quarter notes per minute in this draft.")
    first = float(meter["first_one"])
    if not math.isfinite(first) or not 0 <= first < duration:
        raise ValueError("First ONE must be inside the song.")
    pattern = meter.get("pattern", "quarter")
    if pattern not in ("quarter", "eighth", "332"):
        raise ValueError("Choose quarter notes, eighth notes, or eighth-note 3+3+2.")
    if pattern == "332" and numerator != 4:
        raise ValueError("3+3+2 uses eight eighth notes in 4/4.")
    subdivision = 1 if pattern == "quarter" else 2
    pulses = []
    for i, beat in enumerate(beats):
        pulses.append(float(beat))
        if subdivision == 2 and i + 1 < len(beats):
            pulses.append(float((beat + beats[i+1]) / 2))
    index = int(np.argmin(np.abs(np.asarray(pulses) - first)))
    cycle = numerator * subdivision
    group_offsets = [0, 3, 6] if pattern == "332" else [0]
    downbeats = pulses[index::cycle]
    accents = [t for i, t in enumerate(pulses)
               if i >= index and (i-index) % cycle in group_offsets[1:]]
    return {"numerator": numerator, "denominator": 4, "bpm_unit": "quarter",
            "pattern": pattern, "subdivision": subdivision,
            "grouping": [3, 3, 2] if pattern == "332" else [cycle],
            "pulses_per_cycle": cycle, "pulse_times": pulses,
            "requested_first_one": first, "first_one": pulses[index],
            "first_one_beat_index": int(np.argmin(np.abs(np.asarray(beats)-pulses[index]))),
            "first_one_pulse_index": index,
            "downbeat_times": downbeats, "group_accent_times": accents}
