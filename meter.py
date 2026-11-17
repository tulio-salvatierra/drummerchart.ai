"""Downbeat and meter estimation per section.

Two accent sources feed one decoder:
  * madmom's RNN downbeat activation (preferred; needs the GitHub build of madmom), and
  * a heuristic: low-frequency (kick-range) onset energy at each beat.
The decoder scores accent periodicity for 2, 3, 4 and 6 beats per bar inside each section
and picks the period + phase with the strongest contrast.

How meters map onto the detected beat grid: the beat tracker's pulse is never changed.
A meter only says how many detected beats make one bar (its numerator): 4/4 = 4 beats,
3/4 = 3, 6/8 = 6, 7/8 = 7, 12/8 = 12. So in 6/8 every detected pulse is treated as an
eighth note; if the tracker locks onto the dotted quarter instead, 2/4 is the right pick.
"""
from __future__ import annotations

import numpy as np

METER_BEATS = {"2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5, "6/8": 6, "7/8": 7, "12/8": 12}
PERIOD_TO_METER = {2: "2/4", 3: "3/4", 4: "4/4", 6: "6/8"}
LOW_CONFIDENCE = 0.5


def beats_per_bar(meter: str) -> int:
    if meter in METER_BEATS:
        return METER_BEATS[meter]
    try:
        n = int(str(meter).split("/")[0])
    except (ValueError, IndexError):
        return 4
    return n if 1 <= n <= 32 else 4


MADMOM_FPS = 100.0


def madmom_activation(path: str) -> np.ndarray | None:
    """madmom's RNN beat/downbeat activation, (frames @100 fps, [beat, downbeat]),
    or None if madmom is unavailable. Computed once per song and shared by the beat
    tracker and the meter guess."""
    try:
        from madmom.features.downbeats import RNNDownBeatProcessor
    except Exception:
        return None
    try:
        return RNNDownBeatProcessor()(str(path))
    except Exception:
        return None


def madmom_beats(act: np.ndarray) -> np.ndarray | None:
    """Beat times from the activation (DBN tracker, 55-215 BPM), or None."""
    try:
        from madmom.features.beats import DBNBeatTrackingProcessor
    except Exception:
        return None
    try:
        beats = DBNBeatTrackingProcessor(fps=MADMOM_FPS, min_bpm=55, max_bpm=215)(act.sum(axis=1))
    except Exception:
        return None
    return np.asarray(beats, dtype=float) if len(beats) >= 4 else None


def madmom_accents(path: str, beat_times: np.ndarray, act: np.ndarray | None = None) -> np.ndarray | None:
    """Downbeat activation sampled at each beat, or None if madmom is unavailable."""
    if act is None:
        act = madmom_activation(path)
    if act is None:
        return None
    fps = MADMOM_FPS
    out = np.zeros(len(beat_times))
    for i, t in enumerate(beat_times):
        lo = max(0, int(round((t - 0.05) * fps)))
        hi = min(len(act), int(round((t + 0.05) * fps)) + 1)
        if hi > lo:
            out[i] = float(np.max(act[lo:hi, 1]))
    return out


def low_frequency_accents(y: np.ndarray, sr: int, beat_times: np.ndarray) -> np.ndarray:
    """Heuristic accent: kick-range (<150 Hz) energy rise around each beat."""
    import librosa

    hop = 256
    spec = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low = np.log1p(1000.0 * spec[freqs < 150].sum(axis=0))
    flux = np.maximum(0.0, np.diff(low, prepend=low[0]))
    fps = sr / hop
    out = np.zeros(len(beat_times))
    for i, t in enumerate(beat_times):
        lo = max(0, int(round((t - 0.06) * fps)))
        hi = min(len(flux), int(round((t + 0.06) * fps)) + 1)
        if hi > lo:
            out[i] = float(np.max(flux[lo:hi]))
    return out


def _zscore(x: np.ndarray) -> np.ndarray:
    sd = float(np.std(x))
    return (x - float(np.mean(x))) / sd if sd > 1e-9 else np.zeros_like(x)


def _best_phase(a: np.ndarray, p: int) -> tuple[float, int]:
    best = (-np.inf, 0)
    for phase in range(p):
        mask = np.zeros(len(a), dtype=bool)
        mask[phase::p] = True
        s = float(a[mask].mean() - a[~mask].mean())
        if s > best[0]:
            best = (s, phase)
    return best


def _alternation(a: np.ndarray, p: int, phase2: int) -> float:
    """For bar length p vs 2p: how strong is the in-between accent relative to the
    main one? ~1 means every p-th beat is equally accented (bar = p); ~0 means only
    every 2p-th beat is (bar = 2p)."""
    strong = a[phase2 :: 2 * p]
    weak = a[(phase2 + p) % (2 * p) :: 2 * p]
    mask = np.ones(len(a), dtype=bool)
    mask[phase2 % p :: p] = False
    base = float(a[mask].mean()) if mask.any() else 0.0
    top = float(strong.mean()) - base
    if top <= 1e-9 or len(weak) == 0:
        return 1.0
    return float(np.clip((float(weak.mean()) - base) / top, 0.0, 1.5))


ALTERNATION_SPLIT = 0.6


def score_section(accent: np.ndarray, periods=(2, 3, 4, 6)) -> dict:
    """Best (period, phase) for one section's per-beat accent values.

    Score = mean accent on the candidate downbeats minus mean accent elsewhere. Bar
    lengths come in families (2 vs 4, 3 vs 6) that the contrast score alone can't
    separate, so inside a family the choice is made by the alternation ratio.
    Returns {period, phase, confidence, scores}.
    """
    a = _zscore(np.asarray(accent, dtype=float))
    scores = {p: _best_phase(a, p) for p in periods if len(a) >= 2 * p}
    if not scores:
        return {"period": 4, "phase": 0, "confidence": 0.0, "scores": {}}

    winners = []  # (score, period, phase, alternation certainty)
    for small, big in ((2, 4), (3, 6)):
        if small in scores and big in scores:
            ratio = _alternation(a, small, scores[big][1])
            if ratio >= ALTERNATION_SPLIT:
                certainty = np.clip((ratio - ALTERNATION_SPLIT) / 0.25, 0.0, 1.0)
                winners.append((scores[small][0], small, scores[small][1], float(certainty)))
            else:
                certainty = np.clip((ALTERNATION_SPLIT - ratio) / 0.25, 0.0, 1.0)
                winners.append((scores[big][0], big, scores[big][1], float(certainty)))
        else:
            for p in (small, big):
                if p in scores:
                    winners.append((scores[p][0], p, scores[p][1], 1.0))
    winners.sort(reverse=True)
    top, period, phase, certainty = winners[0]
    runner = winners[1][0] if len(winners) > 1 else 0.0
    margin = (top - max(runner, 0.0)) / top if top > 1e-9 else 0.0
    confidence = min(float(np.clip(2.0 * margin, 0.0, 1.0)), certainty) * float(np.clip(top, 0.0, 1.0))
    return {"period": period, "phase": phase, "confidence": round(confidence, 3),
            "scores": {p: round(s, 3) for p, (s, _) in scores.items()}}


def _unit(x: np.ndarray) -> np.ndarray:
    x = np.maximum(np.asarray(x, dtype=float), 0.0)
    ref = float(np.percentile(x, 90)) if x.size else 0.0
    return np.clip(x / ref, 0.0, 1.5) if ref > 1e-9 else np.zeros_like(x)


def combine_accents(*sources: np.ndarray | None) -> np.ndarray:
    """Average the available accent sources on a common 0..1.5 scale."""
    return np.mean([_unit(s) for s in sources if s is not None], axis=0)
