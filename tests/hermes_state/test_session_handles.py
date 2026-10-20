"""Session handles: a short typeable name per session beside its machine id (hermes_state_handles.py)."""

import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from hermes_state import SessionDB
from hermes_state_handles import handle_for

_HANDLE_SHAPE = r"^[a-z]+-[a-z]+-[a-z]+$"
_COMPLETER = Path(__file__).resolve().parents[2] / "hermes_cli" / "session_complete.py"


@pytest.fixture
def db(tmp_path):
    store = SessionDB(db_path=tmp_path / "state.db")
    yield store
    store.close()


def test_every_create_path_mints_a_handle_and_a_retry_keeps_it(db):
    """Constructor upsert, the retried create of the same id, and a compression child each carry a handle."""
    db.create_session("s1", "cli")
    first = db.get_session("s1")["handle"]
    db.create_session("s1", "cli")
    assert db.get_session("s1")["handle"] == first
    assert first == handle_for("s1")

    db.append_message("s1", "user", "hello")
    db.publish_compression_child(parent_session_id="s1", child_session_id="s1-child", source="cli",
                                 messages=[{"role": "user", "content": "summary"}], require_compression_lease=False)
    child = db.get_session("s1-child")["handle"]
    assert child and child != first
    assert re.match(_HANDLE_SHAPE, first) and re.match(_HANDLE_SHAPE, child)


def test_handle_collision_moves_to_the_next_draw(db):
    """Another row already holding this id's first draw: the new row takes the next salt, never a duplicate."""
    db.create_session("other", "cli")
    db._execute_write(lambda conn: conn.execute(
        "UPDATE sessions SET handle = ? WHERE id = 'other'", (handle_for("taken"),)))
    db.create_session("taken", "cli")
    assert db.get_session("taken")["handle"] == handle_for("taken", 1)


def test_handle_resolves_wherever_an_id_does(db, tmp_path, monkeypatch):
    """resolve_session_id (sessions delete/rename/export, TUI, gateway) and -r/-c take a handle, any case."""
    db.create_session("20261020_101010_abcdef", "cli")
    handle = db.get_session("20261020_101010_abcdef")["handle"]
    assert db.resolve_session_id(handle) == "20261020_101010_abcdef"
    assert db.resolve_session_id(handle.upper()) == "20261020_101010_abcdef"

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from hermes_cli.main import _resolve_session_by_name_or_id
    assert _resolve_session_by_name_or_id(handle) == "20261020_101010_abcdef"


def test_open_fills_handles_on_rows_written_without_one(tmp_path):
    """Rows from before the column, or from a raw INSERT path, get a unique handle on the next open."""
    path = tmp_path / "state.db"
    SessionDB(db_path=path).close()
    conn = sqlite3.connect(path)
    conn.executemany("INSERT INTO sessions (id, source, started_at) VALUES (?, 'cli', 0)",
                     [(f"legacy-{i}",) for i in range(50)])
    conn.commit()
    conn.close()

    store = SessionDB(db_path=path)
    rows = store._read_all("SELECT handle FROM sessions")
    store.close()
    handles = [r["handle"] for r in rows]
    assert all(handles) and len(set(handles)) == len(handles) == 50


def test_moved_session_keeps_or_remints_its_handle(tmp_path):
    """A session moved between profiles keeps its handle unless the target already uses it."""
    source = SessionDB(db_path=tmp_path / "a.db")
    target = SessionDB(db_path=tmp_path / "b.db")
    try:
        source.create_session("moved", "cli")
        target.create_session("resident", "cli")
        clash = target.get_session("resident")["handle"]
        source._execute_write(lambda conn: conn.execute("UPDATE sessions SET handle = ? WHERE id = 'moved'", (clash,)))

        target.import_moved_session(source.export_session_for_move("moved"), profile_name="default")
        moved = target.get_session("moved")["handle"]
        assert moved and moved != clash
    finally:
        source.close()
        target.close()


def _complete(home, prefix, *words, **env):
    result = subprocess.run(
        [sys.executable, "-I", "-S", str(_COMPLETER), prefix, *words],
        capture_output=True, text=True, check=True,
        env={"HOME": str(home.parent), "PATH": os.environ.get("PATH", ""), **env})
    return result.stdout.splitlines()


def test_completer_lists_handle_and_title_newest_first(tmp_path):
    """The Tab source runs without importing Hermes, filters by prefix, and reads the profile -p names."""
    home = tmp_path / ".hermes"
    for name, db_home in (("default", home), ("work", home / "profiles" / "work")):
        db_home.mkdir(parents=True)
        store = SessionDB(db_path=db_home / "state.db")
        store.create_session(f"{name}-old", "cli")
        store.create_session(f"{name}-new", "cli")
        store.set_session_title(f"{name}-new", f"{name} tern charts")
        store._execute_write(lambda conn: conn.execute(
            "UPDATE sessions SET started_at = CASE WHEN id LIKE '%-new' THEN 2 ELSE 1 END"))
        store.close()

    lines = _complete(home, "")
    new, old = handle_for("default-new"), handle_for("default-old")
    assert lines == [f"{new}\tdefault tern charts", old]
    assert _complete(home, new) == [f"{new}\tdefault tern charts"]
    assert _complete(home, "zzz") == []
    assert _complete(home, "", "hermes", "-p", "work", "-r")[0] == f"{handle_for('work-new')}\twork tern charts"
    assert _complete(home, "", HERMES_HOME=str(home / "profiles" / "work"))[0].startswith(handle_for("work-new"))
