import json
import sys
import time
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

FIXTURE_DIR = ROOT / "tests" / "fixtures"
NAMES = ["A", "B", "C", "D", "E"]


@pytest.fixture(scope="session")
def fixture_dir() -> Path:
    """Synthesize the fixture songs on first use (they are not committed)."""
    missing = [n for n in NAMES if not (FIXTURE_DIR / f"{n}.mp3").exists() or not (FIXTURE_DIR / f"{n}.json").exists()]
    if missing:
        import make_fixtures

        make_fixtures.make_all(FIXTURE_DIR, missing)
    return FIXTURE_DIR


@pytest.fixture(scope="session")
def truth(fixture_dir) -> dict:
    return {n: json.loads((fixture_dir / f"{n}.json").read_text()) for n in NAMES}


@pytest.fixture(scope="session")
def analyses(fixture_dir) -> dict:
    """Analyze every fixture once. Each value: {"result": ..., "seconds": ...}."""
    import analyzer

    out = {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for name in NAMES:
            start = time.perf_counter()
            result = analyzer.analyze_song(fixture_dir / f"{name}.mp3")
            out[name] = {"result": result, "seconds": time.perf_counter() - start}
    return out
