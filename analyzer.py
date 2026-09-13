from pathlib import Path

import librosa
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks


def _detect_section_boundaries(y: np.ndarray, sr: int, beat_frames: np.ndarray) -> np.ndarray:
    """Return candidate structural boundaries, snapped to detected beats.

    Pass 1 deliberately detects change points only; it does not label verse/chorus/etc.
    """
    hop_length = 512
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop_length)

    # Normalize each feature family so MFCC magnitude does not swamp chroma.
    chroma = librosa.util.normalize(chroma, axis=1)
    mfcc = librosa.util.normalize(mfcc, axis=1)
    features = np.vstack([chroma, mfcc])

    # Beat-synchronous features make structural changes less sensitive to local timing.
    if len(beat_frames) >= 8:
        sync = librosa.util.sync(features, beat_frames, aggregate=np.median)
        frame_positions = beat_frames[: sync.shape[1]]
    else:
        sync = features
        frame_positions = np.arange(sync.shape[1])

    if sync.shape[1] < 8:
        return np.array([], dtype=float)

    # Self-similarity matrix. A boundary tends to create a change in similarity profile.
    recurrence = librosa.segment.recurrence_matrix(
        sync,
        width=3,
        mode="affinity",
        metric="cosine",
        sym=True,
    )

    # Novelty: compare neighboring columns of the recurrence matrix. This is intentionally
    # simple and tunable; real-song listening tests are the goal of Pass 1.
    column_change = np.linalg.norm(np.diff(recurrence, axis=1), axis=0)
    novelty = np.pad(column_change, (1, 0))
    novelty = gaussian_filter1d(novelty.astype(float), sigma=1.5)

    if not np.any(novelty > 0):
        return np.array([], dtype=float)

    # Keep sections from fragmenting into tiny changes. At a typical 4/4 tempo this
    # corresponds roughly to several bars; beat snapping happens below.
    min_distance = max(4, int(sync.shape[1] * 0.035))
    threshold = float(np.median(novelty) + 0.65 * np.std(novelty))
    peaks, _ = find_peaks(novelty, height=threshold, distance=min_distance, prominence=0.05 * np.max(novelty))

    if len(peaks) == 0:
        return np.array([], dtype=float)

    peaks = peaks[(peaks > 2) & (peaks < sync.shape[1] - 2)]
    frames = frame_positions[np.clip(peaks, 0, len(frame_positions) - 1)]
    return librosa.frames_to_time(frames, sr=sr, hop_length=hop_length)


def analyze_song(path: str | Path) -> dict:
    y, sr = librosa.load(path, sr=22050, mono=True)
    if y.size == 0:
        raise ValueError("The uploaded MP3 contains no decodable audio.")

    duration = float(librosa.get_duration(y=y, sr=sr))
    if duration < 5:
        raise ValueError("Audio is too short to analyze reliably.")

    hop_length = 512
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop_length,
        bpm=librosa.feature.tempo(onset_envelope=onset_env, sr=sr, hop_length=hop_length),
        sparse=True,
    )
    beat_frames = np.asarray(beat_frames, dtype=int)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)

    if len(beat_times) < 4:
        raise ValueError("Not enough beats were detected to build a click track.")

    boundaries = _detect_section_boundaries(y, sr, beat_frames)

    # Snap each candidate to the nearest actual beat and de-duplicate nearby results.
    snapped = []
    for boundary in boundaries:
        idx = int(np.argmin(np.abs(beat_times - boundary)))
        candidate = float(beat_times[idx])
        if candidate < 4.0 or candidate > duration - 4.0:
            continue
        if not snapped or candidate - snapped[-1] >= 6.0:
            snapped.append(candidate)

    return {
        "duration": duration,
        "beat_times": np.asarray(beat_times, dtype=float),
        "boundary_times": np.asarray(snapped, dtype=float),
    }
