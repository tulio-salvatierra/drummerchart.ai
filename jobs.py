"""One folder per upload: jobs/<job_id>/{input.mp3, analysis.json, click.wav, mix.wav}."""
from __future__ import annotations

import os
import re
import shutil
import time
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_DURATION_SECONDS = 10 * 60
MAX_JOB_AGE_SECONDS = 2 * 60 * 60


def jobs_root() -> Path:
    root = Path(os.environ.get("DRUMMERCHART_JOBS_DIR", BASE_DIR / "jobs"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def is_valid_job_id(job_id: str) -> bool:
    return bool(JOB_ID_RE.fullmatch(job_id or ""))


def create_job() -> tuple[str, Path]:
    job_id = uuid.uuid4().hex
    path = jobs_root() / job_id
    path.mkdir()
    return job_id, path


def job_path(job_id: str) -> Path | None:
    """Folder for an existing job, or None. The id format check blocks path traversal."""
    if not is_valid_job_id(job_id):
        return None
    path = jobs_root() / job_id
    return path if path.is_dir() else None


def delete_job(job_id: str) -> None:
    path = job_path(job_id)
    if path:
        shutil.rmtree(path, ignore_errors=True)


def cleanup_old_jobs(max_age_seconds: float = MAX_JOB_AGE_SECONDS) -> int:
    """Remove job folders older than the limit. Returns how many were removed."""
    cutoff = time.time() - max_age_seconds
    removed = 0
    for entry in jobs_root().iterdir():
        if entry.is_dir() and is_valid_job_id(entry.name) and entry.stat().st_mtime < cutoff:
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed
