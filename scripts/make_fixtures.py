"""Synthesize test songs with known ground truth.

Each fixture is a drum pattern (kick accented on beat 1) plus a bass/chord layer whose
harmony and timbre change at section boundaries. Output: <name>.mp3 + <name>.json
(bpm, beats, downbeats, markers with meters) in tests/fixtures/.

Usage: python scripts/make_fixtures.py [out_dir]
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
METER_BEATS = {"2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5, "6/8": 6, "7/8": 7, "12/8": 12}

# Chord progressions as (root midi, minor?) per bar, cycled.
PROGS = {
    "c_major": [(48, False), (53, False), (55, False), (48, False)],
    "a_minor": [(45, True), (41, False), (48, False), (43, False)],
    "e_minor": [(52, True), (48, False), (50, False), (47, True)],
    "f_major": [(53, False), (58, False), (50, True), (48, False)],
    "d_dorian": [(50, True), (55, False), (50, True), (57, True)],
    "g_major": [(43, False), (47, True), (48, False), (50, False)],
}


def _hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _kick(amp: float) -> np.ndarray:
    t = np.arange(int(0.16 * SR)) / SR
    freq = 50 + 90 * np.exp(-35 * t)
    return amp * np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-22 * t)


def _snare(amp: float, rng: np.random.Generator) -> np.ndarray:
    t = np.arange(int(0.12 * SR)) / SR
    noise = rng.standard_normal(t.size)
    return amp * (0.7 * noise + 0.4 * np.sin(2 * np.pi * 190 * t)) * np.exp(-30 * t)


def _hat(amp: float, rng: np.random.Generator) -> np.ndarray:
    t = np.arange(int(0.03 * SR)) / SR
    noise = np.diff(rng.standard_normal(t.size + 1))  # crude high-pass
    return amp * noise * np.exp(-120 * t)


def _wave(freq: float, n: int, timbre: str) -> np.ndarray:
    t = np.arange(n) / SR
    if timbre == "saw":
        partials = [(k, 1.0 / k) for k in range(1, 9)]
    elif timbre == "square":
        partials = [(k, 1.0 / k) for k in range(1, 12, 2)]
    elif timbre == "organ":
        partials = [(1, 1.0), (2, 0.5), (4, 0.25)]
    else:  # "soft"
        partials = [(1, 1.0), (3, 0.08)]
    out = np.zeros(n)
    for k, a in partials:
        if freq * k < SR / 2.2:
            out += a * np.sin(2 * np.pi * freq * k * t)
    return out / max(1e-9, sum(a for _, a in partials))


def _add(buf: np.ndarray, sound: np.ndarray, time_s: float) -> None:
    start = int(round(time_s * SR))
    end = min(buf.size, start + sound.size)
    if end > start >= 0:
        buf[start:end] += sound[: end - start]


def _drum_bar(buf, t0, period, meter, rng):
    n = METER_BEATS[meter]
    if meter == "4/4":
        kicks, snares = {0: 1.0, 2: 0.45}, {1: 0.6, 3: 0.6}
    elif meter == "3/4":
        kicks, snares = {0: 1.0}, {1: 0.35, 2: 0.4}
    elif meter == "6/8":
        kicks, snares = {0: 1.0}, {3: 0.55}
    else:
        kicks, snares = {0: 1.0}, {n // 2: 0.5}
    for b in range(n):
        t = t0 + b * period
        if b in kicks:
            _add(buf, _kick(kicks[b]), t)
        if b in snares:
            _add(buf, _snare(snares[b], rng), t)
        _add(buf, _hat(0.22, rng), t)
        if meter != "6/8":  # eighth-note hats for simple meters
            _add(buf, _hat(0.12, rng), t + period / 2)


def _harmony_bar(buf, t0, bar_len, chord, timbre, octave):
    root, minor = chord
    n = int(bar_len * SR)
    env = np.minimum(1.0, np.arange(n) / (0.01 * SR)) * np.minimum(1.0, (n - np.arange(n)) / (0.03 * SR))
    tones = [root, root + (3 if minor else 4), root + 7]
    chord_sig = sum(_wave(_hz(m + 12 * octave), n, timbre) for m in tones) / 3.0
    bass = _wave(_hz(root - 12), n, "soft")
    _add(buf, 0.22 * chord_sig * env, t0)
    _add(buf, 0.30 * bass * env, t0)


FIXTURES = {
    # name: (bpm, lead-in seconds, [(meter, bars, progression, timbre, octave)])
    "A": (120, 2.5, [
        ("4/4", 20, "c_major", "soft", 1),
        ("4/4", 24, "a_minor", "saw", 1),
        ("4/4", 22, "f_major", "organ", 2),
        ("4/4", 24, "e_minor", "square", 1),
    ]),
    "B": (90, 0.4, [
        ("4/4", 16, "c_major", "organ", 1),
        ("3/4", 24, "d_dorian", "saw", 1),
        ("4/4", 16, "g_major", "square", 2),
    ]),
    "C": (140, 3.2, [
        ("6/8", 12, "a_minor", "soft", 1),
        ("4/4", 20, "c_major", "saw", 2),
        ("6/8", 12, "a_minor", "soft", 1),
        ("4/4", 20, "c_major", "saw", 2),
    ]),
    "D": (100, 3.0, [
        ("4/4", 12, "e_minor", "soft", 1),
        ("4/4", 20, "g_major", "saw", 1),
        ("4/4", 16, "c_major", "organ", 2),
        ("4/4", 20, "g_major", "saw", 1),
        ("4/4", 12, "d_dorian", "square", 2),
        ("4/4", 20, "c_major", "organ", 2),
    ]),
    # E: starts with a 2-beat pickup (snare + hats, no kick) before the first downbeat.
    "E": (110, 2.2, [
        ("4/4", 16, "c_major", "soft", 1),
        ("4/4", 16, "a_minor", "saw", 1),
    ]),
}
PICKUP_BEATS = {"E": 2}


def synthesize(name: str) -> tuple[np.ndarray, dict]:
    bpm, lead_in, sections = FIXTURES[name]
    rng = np.random.default_rng(ord(name))
    period = 60.0 / bpm
    total_beats = sum(METER_BEATS[m] * bars for m, bars, *_ in sections)
    duration = lead_in + total_beats * period + 1.5
    buf = np.zeros(int(duration * SR))
    beats, downbeats, markers = [], [], []
    for k in range(PICKUP_BEATS.get(name, 0), 0, -1):
        tp = lead_in - k * period
        beats.append(round(tp, 6))
        _add(buf, _snare(0.45, rng), tp)
        _add(buf, _hat(0.22, rng), tp)
        _add(buf, _hat(0.12, rng), tp + period / 2)
    t = lead_in
    for meter, bars, prog_name, timbre, octave in sections:
        markers.append({"time": round(t, 6), "meter": meter})
        prog = PROGS[prog_name]
        n = METER_BEATS[meter]
        for bar in range(bars):
            downbeats.append(round(t, 6))
            beats.extend(round(t + b * period, 6) for b in range(n))
            _drum_bar(buf, t, period, meter, rng)
            _harmony_bar(buf, t, n * period, prog[bar % len(prog)], timbre, octave)
            t += n * period
    buf *= 0.9 / np.max(np.abs(buf))
    truth = {"name": name, "bpm": bpm, "duration": round(duration, 6), "beats": beats,
             "downbeats": downbeats, "markers": markers}
    return buf.astype(np.float32), truth


def make_all(out_dir: Path, names=None) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in names or FIXTURES:
        audio, truth = synthesize(name)
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "x.wav"
            sf.write(wav, audio, SR, subtype="PCM_16")
            mp3 = out_dir / f"{name}.mp3"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                            "-codec:a", "libmp3lame", "-b:a", "128k", str(mp3)], check=True)
        (out_dir / f"{name}.json").write_text(json.dumps(truth))
        print(f"{name}: {truth['duration']:.1f}s, {len(truth['beats'])} beats, {len(truth['markers'])} sections")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "tests" / "fixtures"
    make_all(target)
