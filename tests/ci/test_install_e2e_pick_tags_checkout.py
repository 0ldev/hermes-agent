"""Install/update E2E baseline picking survives the tagless shallow checkout it runs on.

The `Pick release tags` job checks out ONE commit with no tags (Blacksmith's checkout
fetches `--depth=1 origin <sha>`; `fetch-tags: true` brings none for a single commit).
Its own steps must fetch the release tags before the picker reads them; when none did,
every stable release failed with "No released baseline tags remain" (rc.1-v0.22.3).
"""
import os
import subprocess
from pathlib import Path

from ruamel.yaml import YAML

from scripts.releases.pick_tags import pick_tags

ROOT = Path(__file__).resolve().parents[2]


def _git(cwd, *args, env=None):
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout


def _pre_pick_run_steps():
    """The shell steps `pick-releases` runs between its checkout and the picker."""
    workflow = YAML(typ="safe").load((ROOT / ".github/workflows/install-e2e.yml").read_text(encoding="utf-8"))
    steps = workflow["jobs"]["pick-releases"]["steps"]
    pick = next(index for index, step in enumerate(steps) if step.get("id") == "pick")
    return [step["run"] for step in steps[:pick] if "run" in step]


def test_picker_finds_baselines_after_a_tagless_single_commit_checkout(tmp_path):
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-b", "main")
    _git(origin, "config", "user.name", "fixture")
    _git(origin, "config", "user.email", "fixture@example.invalid")
    for index, tag in enumerate(["v2026.7.20", "v0.27.0", "v0.28.0"]):
        stamp = f"2026-08-{index + 1:02d}T00:00:00Z"
        env = {**os.environ, "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp}
        if tag != "v2026.7.20":
            (origin / "apps" / "desktop").mkdir(parents=True, exist_ok=True)
            (origin / "apps" / "desktop" / "package.json").write_text("{}\n", encoding="utf-8")
            _git(origin, "add", "apps")
        _git(origin, "commit", "--allow-empty", "-m", tag, env=env)
        _git(origin, "tag", "-a", tag, "-m", tag, env=env)
    _git(origin, "commit", "--allow-empty", "-m", "candidate")
    candidate = _git(origin, "rev-parse", "HEAD").strip()

    # The checkout the job gets: one commit, no tags.
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    _git(checkout, "init", "-q")
    _git(checkout, "remote", "add", "origin", origin.as_uri())
    _git(checkout, "fetch", "--depth=1", "origin", candidate)
    _git(checkout, "checkout", "-q", "--detach", candidate)
    assert not _git(checkout, "tag", "--list", "v*").split(), "premise: the checkout carries no tags"

    for run in _pre_pick_run_steps():
        subprocess.run(["bash", "-euo", "pipefail", "-c", run], cwd=checkout, check=True,
                       capture_output=True, text=True, encoding="utf-8")

    picked = pick_tags(checkout, 3, "v0.28.0")
    assert picked == ["v2026.7.20", "v0.27.0"]
    desktop = {tag: bool(_git(checkout, "ls-tree", "-d", tag, "apps/desktop").strip()) for tag in picked}
    assert desktop == {"v2026.7.20": False, "v0.27.0": True}
