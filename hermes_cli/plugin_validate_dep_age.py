"""Admission check: a catalog plugin's Python dependencies are exact pins on releases at least
three days old (catalog rule 10).

Hermes checks the age of its own dependencies when it locks them, and users' machines never check
dates (many package mirrors publish none). For plugins, catalog admission is therefore the only
check: every declared requirement must name one exact version, and that version must have been on
PyPI for ``MIN_AGE``. A range would let a user's install pick a release the catalog never saw.
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timedelta, timezone, UTC
from pathlib import Path
from typing import Callable, Optional

MIN_AGE = timedelta(days=3)
_TIMEOUT = 15


def release_uploaded(name: str, version: str) -> Optional[datetime]:
    """When PyPI first received a file for *name* *version*; ``None`` when PyPI has no such release."""
    from urllib.error import HTTPError

    url = f"https://pypi.org/pypi/{name}/{version}/json"
    try:
        with urllib.request.urlopen(url, timeout=_TIMEOUT) as resp:
            files = json.loads(resp.read()).get("urls") or []
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    stamps = [f["upload_time_iso_8601"] for f in files if f.get("upload_time_iso_8601")]
    return min(datetime.fromisoformat(s) for s in stamps) if stamps else None


def _exact_version(requirement) -> Optional[str]:
    specs = list(requirement.specifier)
    if len(specs) == 1 and specs[0].operator in ("==", "===") and "*" not in specs[0].version:
        return specs[0].version
    return None


def check_dependency_age(report, plugin_dir: Path, *, now: Optional[datetime] = None,
                         uploaded: Callable[[str, str], Optional[datetime]] = release_uploaded) -> None:
    """Fail *report* for any declared requirement that is not ``==`` an existing PyPI release
    uploaded at least ``MIN_AGE`` before *now*."""
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name

    from pm.plugin_declarations import read_python_declaration

    try:
        decl = read_python_declaration(Path(plugin_dir))
    except (ValueError, OSError) as exc:
        report.add("dependency release age", False, f"declaration invalid: {exc}")
        return
    requirements = decl.install_requirements
    if not requirements:
        report.add("dependency release age", True, "no Python dependencies declared")
        return
    now = now or datetime.now(UTC)
    problems: list[str] = []
    for spec in requirements:
        req = Requirement(spec)
        version = _exact_version(req)
        if version is None:
            problems.append(f"{spec}: pin one exact version (`{req.name}==X`)")
            continue
        try:
            when = uploaded(canonicalize_name(req.name), version)
        except (OSError, ValueError) as exc:  # network/API failure is a gate failure, never a pass
            problems.append(f"{req.name}=={version}: could not read its PyPI release date ({exc})")
            continue
        if when is None:
            problems.append(f"{req.name}=={version}: no such release on PyPI")
        elif now - when < MIN_AGE:
            problems.append(f"{req.name}=={version}: released {when:%Y-%m-%d %H:%M} UTC, under "
                            f"{MIN_AGE.days} days ago (eligible {when + MIN_AGE:%Y-%m-%d %H:%M} UTC)")
    report.add("dependency release age", not problems,
               "; ".join(problems) if problems else
               f"{len(requirements)} exact pins, each released at least {MIN_AGE.days} days ago")
