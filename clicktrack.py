from pathlib import Path

import numpy as np
import soundfile as sf


def _tone(frequency: float, duration: float, sr: int, amplitude: float) -> np.ndarray:
    n = max(1, int(duration * sr))
    t = np.arange(n, dtype=float) / sr
    envelope = np.exp(-28.0 * t)
    return amplitude * np.sin(2.0 * np.pi * frequency * t) * envelope


def _mix_at(buffer: np.ndarray, sound: np.ndarray, time_s: float, sr: int) -> None:
    start = max(0, int(round(time_s * sr)))
    end = min(len(buffer), start + len(sound))
    if end > start:
        buffer[start:end] += sound[: end - start]


def render_click_track(
    beat_times: np.ndarray,
    boundary_times: np.ndarray,
    duration: float,
    output_path: str | Path,
    sr: int = 44100,
) -> Path:
    """Render a standalone click WAV following detected beat timestamps exactly."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    audio = np.zeros(int(np.ceil((duration + 0.5) * sr)), dtype=np.float32)
    click = _tone(1200.0, 0.045, sr, 0.62)
    section = _tone(520.0, 0.18, sr, 0.92)

    for beat in beat_times:
        _mix_at(audio, click, float(beat), sr)

    # A lower, longer cue is intentionally unmistakable against the normal click.
    for boundary in boundary_times:
        _mix_at(audio, section, float(boundary), sr)

    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio *= 0.98 / peak

    sf.write(output_path, audio, sr, subtype="PCM_16")
    return output_path
