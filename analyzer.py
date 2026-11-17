"""Song analysis: beats, BPM, section markers, downbeats and a meter guess per section.

Runs once per upload; rendering never calls this module.
"""
from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

import meter as meter_mod

SR = 22050
HOP = 512
MIN_SECTION_BEATS = 16


def _track_beats(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP,
        bpm=librosa.feature.tempo(onset_envelope=onset_env, sr=sr, hop_length=HOP),
        sparse=True,
    )
    beat_frames = np.asarray(beat_frames, dtype=int)
    if len(beat_frames) < 4:
        return beat_frames, librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)
    times = _refine_beat_times(y, sr, librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP))
    times = _extend_to_edges(y, sr, times)
    return librosa.time_to_frames(times, sr=sr, hop_length=HOP), times


def _extend_to_edges(y: np.ndarray, sr: int, times: np.ndarray) -> np.ndarray:
    """The tracker often drops the first/last beat or two. Extrapolate the grid outward
    for as long as there is still music playing at the predicted beat."""
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    floor = 0.3 * float(np.median(rms[rms > 0])) if np.any(rms > 0) else 0.0
    duration = len(y) / sr

    def active(t: float) -> bool:
        lo = max(0, int((t - 0.02) * sr / HOP))
        hi = min(len(rms), int((t + 0.12) * sr / HOP) + 1)
        return hi > lo and float(np.max(rms[lo:hi])) > floor

    out = list(times)
    head = float(np.median(np.diff(times[:5])))
    while out[0] - head >= 0.0 and active(out[0] - head) and len(out) < len(times) + 8:
        out.insert(0, out[0] - head)
    tail = float(np.median(np.diff(times[-5:])))
    while out[-1] + tail <= duration - 0.05 and active(out[-1] + tail) and len(out) < len(times) + 16:
        out.append(out[-1] + tail)
    return np.asarray(out, dtype=float)


def _refine_beat_times(y: np.ndarray, sr: int, beat_times: np.ndarray) -> np.ndarray:
    """Nudge each beat onto the nearest strong onset, at ~3 ms resolution.

    The tracker's grid is quantized to 23 ms frames. Where a clear onset sits within
    +/-40 ms we use it; otherwise the beat keeps its tracked position.
    """
    hop = 64
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, n_fft=1024)
    fps = sr / hop
    # onset_strength peaks slightly after the attack; measure against energy rise instead.
    floor = float(np.percentile(env, 75))
    refined = beat_times.astype(float).copy()
    offsets = np.full(len(beat_times), np.nan)
    for i, t in enumerate(beat_times):
        lo = max(0, int(round((t - 0.04) * fps)))
        hi = min(len(env), int(round((t + 0.04) * fps)) + 1)
        if hi - lo < 3:
            continue
        k = lo + int(np.argmax(env[lo:hi]))
        if env[k] > floor:
            offsets[i] = k / fps - t
    if np.isfinite(offsets).sum() >= max(4, len(offsets) // 4):
        typical = float(np.nanmedian(offsets))
        for i in range(len(refined)):
            # Beats with no onset of their own shift by the typical correction.
            refined[i] += offsets[i] if np.isfinite(offsets[i]) else typical
    # Keep the grid strictly increasing.
    for i in range(1, len(refined)):
        if refined[i] <= refined[i - 1] + 0.05:
            refined[i] = beat_times[i] + (refined[i - 1] - beat_times[i - 1])
    return np.maximum(refined, 0.0)


def estimate_bpm(beat_times: np.ndarray) -> float:
    """Median beat interval -> BPM. Intervals are averaged over 8-beat spans first so
    frame quantization doesn't bias the median."""
    span = min(8, len(beat_times) - 1)
    intervals = (beat_times[span:] - beat_times[:-span]) / span
    return float(60.0 / np.median(intervals))


def _checkerboard(half: int) -> np.ndarray:
    idx = np.arange(-half, half) + 0.5
    taper = np.exp(-0.5 * (idx / (0.5 * half)) ** 2)
    sign = np.sign(idx)
    return np.outer(sign, sign) * np.outer(taper, taper)


def _detect_section_boundaries(y: np.ndarray, sr: int, beat_frames: np.ndarray) -> np.ndarray:
    """Candidate structural boundaries as beat indices.

    Chroma + MFCC, beat-synchronous, cosine self-similarity, then a checkerboard-kernel
    novelty curve (Foote). A wide kernel ignores bar-to-bar chord movement and reacts to
    changes that persist for several bars.
    """
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=HOP)
    n_beats = len(beat_frames)
    if n_beats < 4 * MIN_SECTION_BEATS:
        return np.array([], dtype=int)

    def sync(feat: np.ndarray) -> np.ndarray:
        s = librosa.util.sync(feat, beat_frames, aggregate=np.mean)[:, 1 : n_beats + 1]
        if s.shape[1] < n_beats:  # last beat sits on the final frame
            s = np.pad(s, ((0, 0), (0, n_beats - s.shape[1])), mode="edge")
        s = gaussian_filter1d(s, sigma=2.0, axis=1)  # blur within-bar detail
        s = (s - s.mean(axis=1, keepdims=True)) / (s.std(axis=1, keepdims=True) + 1e-9)
        return s / np.sqrt(s.shape[0])

    feats = np.vstack([sync(chroma), sync(mfcc[1:])])
    unit = feats / (np.linalg.norm(feats, axis=0, keepdims=True) + 1e-9)
    ssm = unit.T @ unit

    half = int(np.clip(n_beats // 8, 8, 24))
    kernel = _checkerboard(half)
    padded = np.pad(ssm, half, mode="reflect")
    novelty = np.array([np.sum(kernel * padded[i : i + 2 * half, i : i + 2 * half]) for i in range(n_beats)])
    novelty = np.maximum(novelty, 0.0) / np.sum(np.abs(kernel))
    novelty = gaussian_filter1d(novelty, sigma=1.0)
    if novelty.max() <= 0:
        return np.array([], dtype=int)

    # A boundary must stand out both in absolute terms (similarity really flips) and
    # against this song's own strongest change.
    height = max(0.12, 0.35 * float(novelty.max()))
    peaks, _ = find_peaks(novelty, height=height, distance=MIN_SECTION_BEATS, prominence=0.5 * height)
    peaks = peaks[(peaks >= MIN_SECTION_BEATS // 2) & (peaks <= n_beats - MIN_SECTION_BEATS // 2)]
    return peaks.astype(int)


def _sections_with_meter(accent: np.ndarray, boundaries: list[int], n_beats: int) -> list[dict]:
    """Score each section's meter, then snap each boundary onto the new section's bar grid."""
    starts = [0] + list(boundaries)
    sections = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else n_beats
        # Score on the section's interior so a slightly-off boundary doesn't leak in.
        pad = 2 if end - start > 24 else 0
        result = meter_mod.score_section(accent[start + pad : end - pad])
        period = result["period"]
        phase = (start + pad + result["phase"]) % period  # absolute beat-index phase
        confident = result["confidence"] >= meter_mod.LOW_CONFIDENCE
        if not confident:
            fallback = meter_mod.score_section(accent[start + pad : end - pad], periods=(4,))
            period, phase = 4, (start + pad + fallback["phase"]) % 4
        sections.append({"start": start, "period": period, "phase": phase,
                         "confidence": result["confidence"], "confident": confident})
    for k, sec in enumerate(sections):
        if k == 0:
            continue
        p, ph = sec["period"], sec["phase"]
        offset = (sec["start"] - ph) % p
        snapped = sec["start"] - offset if offset <= p // 2 else sec["start"] + (p - offset)
        sec["start"] = int(np.clip(snapped, sections[k - 1]["start"] + 1, n_beats - 1))
    return sections


def analyze_song(path: str | Path) -> dict:
    y, sr = librosa.load(path, sr=SR, mono=True)
    if y.size == 0:
        raise ValueError("The uploaded MP3 contains no decodable audio.")
    duration = float(librosa.get_duration(y=y, sr=sr))
    if duration < 5:
        raise ValueError("Audio is too short to analyze reliably.")

    beat_frames, beat_times = _track_beats(y, sr)
    if len(beat_times) < 4:
        raise ValueError("Not enough beats were detected to build a click track.")
    n_beats = len(beat_times)

    boundaries = [int(b) for b in _detect_section_boundaries(y, sr, beat_frames)]

    madmom_acc = meter_mod.madmom_accents(str(path), beat_times)
    heuristic_acc = meter_mod.low_frequency_accents(y, sr, beat_times)
    accent = meter_mod.combine_accents(madmom_acc, heuristic_acc)
    method = "madmom+heuristic" if madmom_acc is not None else "heuristic"

    sections = _sections_with_meter(accent, boundaries, n_beats)

    markers, downbeats = [], []
    first = sections[0]
    pickup = first["phase"] % first["period"]
    # The first marker is always the first beat. If the song starts with pickup beats,
    # a second marker re-anchors bar 1 on the first real downbeat.
    entries = [(0, first, "")]
    if pickup and pickup < (sections[1]["start"] if len(sections) > 1 else n_beats):
        entries.append((pickup, first, "Bar 1"))
    entries += [(sec["start"], sec, "") for sec in sections[1:]]
    for i, (start, sec, label) in enumerate(entries):
        end = entries[i + 1][0] if i + 1 < len(entries) else n_beats
        if end <= start:
            continue
        markers.append({
            "time": round(float(beat_times[start]), 4),
            "meter": meter_mod.PERIOD_TO_METER.get(sec["period"], "4/4"),
            "meter_confidence": float(sec["confidence"]),
            "label": label,
        })
        downbeats.extend(round(float(beat_times[j]), 4) for j in range(start, end, sec["period"]))

    return {
        "duration": round(duration, 4),
        "bpm": round(estimate_bpm(beat_times), 2),
        "beats": [round(float(t), 4) for t in beat_times],
        "downbeats": downbeats,
        "markers": markers,
        "downbeat_method": method,
    }
