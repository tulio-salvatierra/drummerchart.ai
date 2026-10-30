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
