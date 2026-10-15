"""PR #137951 live dogfood on a real Windows runner. TEMPORARY, never merges.

Installs Hermes the way a user does (install.ps1 from raw.githubusercontent at
the commit under test, into the real %LOCALAPPDATA%\\hermes), then runs the
installed `hermes` the way reviewers, test runs and the updater do, and reads
the REAL HKCU\\Environment\\Path before/after each leg. Every leg restores the
registry exactly afterwards, so legs are independent.

usage: dogfood.py <side> <branch> <commit>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import winreg
import zipfile
from pathlib import Path

SIDE, BRANCH, COMMIT = sys.argv[1:4]
T = Path(os.environ["RUNNER_TEMP"]) / "p137951" / SIDE
LOGS = T / "logs"
LOGS.mkdir(parents=True, exist_ok=True)
REAL_LOCAL = Path(os.environ["LOCALAPPDATA"])
REAL_HOME = REAL_LOCAL / "hermes"
REAL_BIN = REAL_HOME / "bin"
EXE = REAL_BIN / "hermes.exe"
RESULTS: list[dict] = []
ENV_KEY = "Environment"


def read_user(name):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ENV_KEY) as key:
        try:
            return winreg.QueryValueEx(key, name)
        except FileNotFoundError:
            return None


def write_user(name, value):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ENV_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if value is None:
            try:
                winreg.DeleteValue(key, name)
            except FileNotFoundError:
                pass
        else:
            winreg.SetValueEx(key, name, 0, value[1], value[0])


def norm(entry):
    return os.path.normcase(os.path.expandvars(entry.strip()).rstrip("\\"))


def entries(value):
    return [e for e in (value or ("", 0))[0].split(";") if e.strip()]


def fresh_console_hermes():
    """What `hermes` resolves to in a console opened now: Machine Path + User Path from the registry."""
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment") as key:
        machine = winreg.QueryValueEx(key, "Path")[0]
    user = (read_user("Path") or ("", 0))[0]
    return shutil.which("hermes", path=os.path.expandvars(machine) + ";" + os.path.expandvars(user))


def tail(path, n=12):
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-n:]


def run(cmd, env_over, log, timeout, cwd=None):
    env = os.environ.copy()
    # The step shell is PowerShell 7; its PSModulePath makes a Windows PowerShell 5 child
    # (install.ps1, any powershell.exe Hermes spawns) fail to load its own built-in cmdlets.
    # A user's console has no such leftover.
    for key in [k for k in env if k.upper() == "PSMODULEPATH"]:  # os.environ upper-cases names on Windows
        env.pop(key)
    for k, v in env_over.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = str(v)
    with open(log, "wb") as out:
        try:
            return subprocess.run(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out,
                                  stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            return "TIMEOUT"


def bootstrap_records(roots, since):
    """expose_cli's own result from each boot-bootstrap record written during the leg."""
    found = {}
    for root in roots:
        for rec in Path(root).glob("installs/*/bootstrap/*.json"):
            if rec.stat().st_mtime >= since:
                try:
                    found[str(rec)] = json.loads(rec.read_text(encoding="utf-8-sig"))["results"].get("expose_cli")
                except (OSError, ValueError, KeyError):
                    found[str(rec)] = "unreadable"
    return found


def launcher_script(exe):
    try:
        with zipfile.ZipFile(exe) as zf:
            return zf.read("__main__.py").decode("utf-8", "replace")
    except (OSError, zipfile.BadZipFile, KeyError) as exc:
        return f"<unreadable: {exc}>"


def record(rec):
    RESULTS.append(rec)
    short = {k: rec.get(k) for k in ("side", "leg", "exit", "added", "removed", "fresh_console_hermes", "expose_cli")}
    print("RESULT " + json.dumps(short), flush=True)


def remove_real_bin():
    value = read_user("Path")
    keep = [e for e in entries(value) if norm(e) != norm(str(REAL_BIN))]
    write_user("Path", (";".join(keep), value[1]))


def leg(name, env_over, argv, pre=None, roots=(), cmd=None, cwd=None):
    saved_path, saved_home = read_user("Path"), read_user("HERMES_HOME")
    try:
        if pre:
            pre()
        before = read_user("Path")
        start = time.time() - 1
        log = LOGS / f"{name}.log"
        rc = run(cmd or [str(EXE), *argv], env_over, log, 900, cwd=cwd)
        after = read_user("Path")
        before_n = {norm(e) for e in entries(before)}
        after_n = {norm(e) for e in entries(after)}
        rec = {
            "side": SIDE, "leg": name, "exit": rc,
            "added": [e for e in entries(after) if norm(e) not in before_n],
            "removed": [e for e in entries(before) if norm(e) not in after_n],
            "fresh_console_hermes": fresh_console_hermes(),
            "expose_cli": bootstrap_records(roots, start),
            "log_tail": tail(log),
        }
        return rec
    finally:
        write_user("Path", saved_path)
        write_user("HERMES_HOME", saved_home)


def main():
    # ── install, as a user would ────────────────────────────────────────────
    script = T / "install.ps1"
    url = f"https://raw.githubusercontent.com/NousResearch/hermes-agent/{COMMIT}/scripts/install.ps1"
    script.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    cwd = T / "install-cwd"
    cwd.mkdir(exist_ok=True)
    path_before_install = read_user("Path")
    t0 = time.time()
    rc = run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
              "-Branch", BRANCH, "-Commit", COMMIT, "-NonInteractive", "-SkipSetup",
              "-SkipBrowser", "-SkipComputerUse"],
             {"HERMES_HOME": None}, LOGS / "install.log", 3000, cwd=cwd)
    head = subprocess.run(["git", "-C", str(REAL_HOME / "hermes-agent"), "rev-parse", "HEAD"],
                          capture_output=True, text=True, encoding="utf-8").stdout.strip()
    after_install = read_user("Path")
    inst = {"side": SIDE, "leg": "install", "exit": rc, "minutes": round((time.time() - t0) / 60, 1),
            "installed_head": head, "expected": COMMIT,
            "added": [e for e in entries(after_install) if norm(e) not in {norm(x) for x in entries(path_before_install)}],
            "removed": [],
            "hermes_exe": EXE.exists(), "fresh_console_hermes": fresh_console_hermes(),
            "log_tail": tail(LOGS / "install.log", 30)}
    record(inst)
    if rc != 0 or not EXE.exists() or head != COMMIT:
        print("\n".join(inst["log_tail"]))
        return 1

    box = T / "box"
    for sub in ("hermes", "local", "user"):
        (box / sub).mkdir(parents=True, exist_ok=True)

    # 1. A review sandbox: HERMES_HOME, LOCALAPPDATA and USERPROFILE all point at a throwaway box.
    record(leg("1_review_sandbox_all_overrides",
               {"HERMES_HOME": box / "hermes", "LOCALAPPDATA": box / "local", "USERPROFILE": box / "user"},
               ["--version"], roots=[box / "hermes"]))
    # 2. A test run / lab run: only HERMES_HOME points at a temp dir.
    record(leg("2_temp_hermes_home_only", {"HERMES_HOME": T / "box2"}, ["--version"], roots=[T / "box2"]))
    # 3. A named profile of the real home must still repair the real entry.
    (REAL_HOME / "profiles" / "work").mkdir(parents=True, exist_ok=True)
    record(leg("3_profile_of_real_home", {"HERMES_HOME": REAL_HOME / "profiles" / "work"}, ["--version"],
               pre=remove_real_bin, roots=[REAL_HOME]))
    # 4. The update-time home steps for the real home re-add a missing entry.
    record(leg("4_real_home_post_update", {"HERMES_HOME": None},
               ["--run-module", "hermes_cli.post_update", "--scope", "home"], pre=remove_real_bin))
    # 5. A custom home stored as a user variable owns the PATH.
    custom = T / "custom"
    record(leg("5_stored_custom_home", {"HERMES_HOME": custom}, ["--version"],
               pre=lambda: write_user("HERMES_HOME", (str(custom), winreg.REG_SZ)), roots=[custom]))
    # 6. A sandbox nested inside the real home (the reviewer's P1.1).
    nested = REAL_HOME / "cache" / "scratch" / "box3"
    nested.mkdir(parents=True, exist_ok=True)
    record(leg("6_nested_sandbox_under_real_home", {"HERMES_HOME": nested}, ["--version"],
               pre=remove_real_bin, roots=[REAL_HOME]))

    # 7. Follow-up class (finding 2): a second checkout of the same commit (a review tree) run with
    #    no HERMES_HOME rebinds the real bin\hermes.exe. Run its launcher script with the same Python.
    try:
        review = T / "rvw137951"
        subprocess.run(["git", "-C", str(REAL_HOME / "hermes-agent"), "worktree", "add", "--detach",
                        str(review), "HEAD"], check=True, capture_output=True)
        script_text = launcher_script(EXE)
        install_root = str((REAL_HOME / "hermes-agent").resolve())
        exe_bytes = EXE.read_bytes()
        m = re.search(rb'#!"?([A-Za-z]:\\[^\r\n"]+?pythonw?\.exe)', exe_bytes)
        python = m.group(1).decode() if m else None
        def esc(s):
            return s.encode("unicode_escape").decode("ascii")

        review_script = script_text
        for old, new in ((esc(install_root), esc(str(review))), (install_root, str(review))):
            review_script = review_script.replace(old, new)
        launcher = T / "review_launcher.py"
        launcher.write_text(review_script, encoding="utf-8")
        before_bound = "rvw137951" in script_text
        rec = leg("7_review_checkout_vs_real_home", {"HERMES_HOME": None}, [],
                  cmd=[python, str(launcher), "--version"], cwd=str(review), roots=[REAL_HOME])
        after_text = launcher_script(EXE)
        rec.update({"python": python, "script_rewritten_for_review": review_script != script_text,
                    "real_hermes_exe_bound_to_review_before": before_bound,
                    "real_hermes_exe_bound_to_review_after": "rvw137951" in after_text})
        record(rec)
    except Exception as exc:  # proof harness: report, never hide
        record({"side": SIDE, "leg": "7_review_checkout_vs_real_home", "exit": f"HARNESS ERROR {exc!r}"})

    (T / "results.json").write_text(json.dumps(RESULTS, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
