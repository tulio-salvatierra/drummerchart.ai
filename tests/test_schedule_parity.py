"""Preview/render parity: static/schedule.js must match schedule.py event for event."""
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

import schedule

ROOT = Path(__file__).resolve().parent.parent
RUNNER = """
const s = require(process.argv[1]);
const cases = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({
  sounds: s.SOUNDS, decay: s.DECAY,
  results: cases.map(c => s.buildClickSchedule(c.beats, c.markers, c.duration)),
}));
"""


def _run_js(cases):
    node = shutil.which("node")
    assert node, "node is required for the preview/render parity test"
    proc = subprocess.run([node, "-e", RUNNER, str(ROOT / "static" / "schedule.js")],
                          input=json.dumps(cases), capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


def _cases(truth):
    cases = []
    for name in "ABCD":
        t = truth[name]
        cases.append({"beats": t["beats"], "markers": t["markers"], "duration": t["duration"]})
        edited = [dict(m) for m in t["markers"]]
        edited[-1]["meter"] = "7/8"
        edited.insert(1, {"time": t["beats"][9] + 0.07, "meter": "5/4"})  # off-grid, snaps
        cases.append({"beats": t["beats"], "markers": edited, "duration": t["duration"]})
    rng = random.Random(7)
    for _ in range(40):
        t, beats = rng.uniform(0.0, 4.0), []
        for _ in range(rng.randint(2, 300)):
            beats.append(round(t, 4))
            t += rng.uniform(0.3, 0.9)
        meters = ["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "12/8"]
        markers = [{"time": rng.uniform(0, t), "meter": rng.choice(meters)} for _ in range(rng.randint(0, 8))]
        if markers and rng.random() < 0.3:
            markers.append(dict(markers[0]))  # duplicate time
        cases.append({"beats": beats, "markers": markers, "duration": rng.choice([t, t - 2.0, t + 1.0])})
    return cases


def test_js_schedule_matches_python(truth):
    cases = _cases(truth)
    js = _run_js(cases)
    for index, (case, js_events) in enumerate(zip(cases, js["results"])):
        py_events = schedule.build_click_schedule(case["beats"], case["markers"], case["duration"])
        assert len(py_events) == len(js_events), f"case {index}"
        for a, b in zip(py_events, js_events):
            assert a["kind"] == b["kind"], f"case {index}"
            assert abs(a["time"] - b["time"]) <= 0.005, f"case {index}"


def test_js_sounds_match_python(truth):
    js = _run_js([])
    assert js["decay"] == schedule.DECAY
    assert set(js["sounds"]) == set(schedule.SOUNDS)
    for kind, values in schedule.SOUNDS.items():
        assert js["sounds"][kind] == pytest.approx(list(values))
