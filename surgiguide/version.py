"""Software version stamp written into every server answer and output (/health, STL headers, guide replies, plan.json of the
pipeline), so a guide can be traced back to the code that made it.

Taken from, in order: YOLMED_VERSION (set by the Docker build: --build-arg GIT_SHA), RAILWAY_GIT_COMMIT_SHA (Railway sets it
at run time), `git describe` of the checkout this file lives in, else "unknown". The release number below is bumped by hand
when the server's output changes on purpose.
"""
import os
import subprocess

RELEASE = "0.4.0"


def _git():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        out = subprocess.run(["git", "-C", here, "describe", "--always", "--dirty", "--abbrev=12"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _commit():
    for k in ("YOLMED_VERSION", "RAILWAY_GIT_COMMIT_SHA", "GIT_SHA"):
        v = (os.environ.get(k) or "").strip()
        if v and v != "unknown":
            return v[:40]
    return _git() or "unknown"


COMMIT = _commit()
VERSION = f"{RELEASE}+{COMMIT[:12]}"


def info():
    return {"release": RELEASE, "commit": COMMIT, "version": VERSION}
