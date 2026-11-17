"""Render the click schedule to WAV: standalone click, and click mixed over the song.

No analysis happens here: input is the saved beats + the markers the user confirmed.
"""
from __future__ import annotations

from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from schedule import DECAY, SOUNDS, build_click_schedule

SR = 44100


def _tone(frequency: float, duration: float, amplitude: float, sr: int = SR) -> np.ndarray:
    n = max(1, int(duration * sr))
    t = np.arange(n, dtype=float) / sr
    return amplitude * np.sin(2.0 * np.pi * frequency * t) * np.exp(-DECAY * t)


def _mix_at(buffer: np.ndarray, sound: np.ndarray, time_s: float, sr: int) -> None:
    start = max(0, int(round(time_s * sr)))
    end = min(len(buffer), start + len(sound))
    if end > start:
        buffer[start:end] += sound[: end - start]


def render_click(events: list[dict], duration: float, sr: int = SR) -> np.ndarray:
    """Mono float click track, exactly `duration` long, peak <= 0.98."""
    audio = np.zeros(int(np.ceil(duration * sr)), dtype=np.float32)
    tones = {kind: _tone(f, d, a, sr) for kind, (f, d, a) in SOUNDS.items()}
    for event in events:
        _mix_at(audio, tones[event["kind"]], float(event["time"]), sr)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio *= 0.98 / peak
    return audio


def _load_song(path: Path, sr: int = SR) -> np.ndarray:
    """Decode the upload to float32 (frames, channels) at `sr`."""
    data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    if file_sr != sr:
        g = gcd(int(file_sr), sr)
        data = resample_poly(data, sr // g, int(file_sr) // g, axis=0).astype(np.float32)
    return data


def render_mix(click: np.ndarray, song: np.ndarray) -> np.ndarray:
    """Song + click. The song is turned down a little so the click reads clearly without
    burying the music; the sum is scaled back if it would clip."""
    n = len(click)
    if len(song) < n:
        song = np.pad(song, ((0, n - len(song)), (0, 0)))
    song = song[:n]
    song_peak = float(np.max(np.abs(song))) if song.size else 0.0
    song_gain = min(1.0, 0.7 / song_peak) if song_peak > 0 else 1.0
    mix = song * song_gain + 0.6 * click[:, None]
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.98:
        mix *= 0.98 / peak
    return mix.astype(np.float32)


def render_job(beats: list[float], markers: list[dict], duration: float, song_path: Path,
               click_path: Path, mix_path: Path) -> None:
    events = build_click_schedule(beats, markers, duration)
    click = render_click(events, duration)
    sf.write(str(click_path), click, SR, subtype="PCM_16")
    mix = render_mix(click, _load_song(song_path))
    sf.write(str(mix_path), mix, SR, subtype="PCM_16")
