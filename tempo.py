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
    """Quarter-note meters only; downbeat selection snaps to the reviewed grid."""
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
    index = int(np.argmin(np.abs(np.asarray(beats) - first)))
    return {"numerator": numerator, "denominator": 4, "bpm_unit": "quarter",
            "requested_first_one": first, "first_one": float(beats[index]),
            "first_one_beat_index": index,
            "downbeat_times": list(beats[index::numerator])}
