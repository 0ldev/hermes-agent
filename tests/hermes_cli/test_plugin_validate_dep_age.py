"""Catalog rule 10: plugin Python deps are exact pins on releases at least three days old."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone, UTC
from pathlib import Path

from hermes_cli.plugin_validate import ValidationReport
from hermes_cli.plugin_validate_dep_age import check_dependency_age

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=UTC)
RELEASES = {("requests", "2.32.4"): NOW - timedelta(days=90), ("fresh-lib", "1.0.1"): NOW - timedelta(days=1)}


def _plugin(root: Path, deps: list[str]) -> Path:
    root.mkdir(parents=True)
    listed = ", ".join(f'"{d}"' for d in deps)
    (root / "pyproject.toml").write_text(f'[project]\nname = "p"\nversion = "1"\ndependencies = [{listed}]\n',
                                         encoding="utf-8")
    return root


def _check(plugin: Path) -> tuple[bool, str]:
    report = ValidationReport()
    check_dependency_age(report, plugin, now=NOW, uploaded=lambda n, v: RELEASES.get((n, v)))
    [(_name, ok, detail)] = report.checks
    return ok, detail


def test_old_exact_pins_pass_and_fresh_range_or_unknown_pins_fail_by_name(tmp_path):
    ok, _ = _check(_plugin(tmp_path / "good", ["requests==2.32.4"]))
    assert ok

    ok, detail = _check(_plugin(tmp_path / "bad", [
        "requests==2.32.4", "fresh-lib==1.0.1", "requests>=2.0", "ghost==9.9.9"]))
    assert not ok
    assert "fresh-lib==1.0.1: released 2026-10-11" in detail and "eligible 2026-10-14" in detail
    assert "requests>=2.0: pin one exact version" in detail
    assert "ghost==9.9.9: no such release on PyPI" in detail
    assert detail.count("requests==2.32.4") == 0
