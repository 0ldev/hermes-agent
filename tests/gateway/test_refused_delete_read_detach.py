"""A refused picker delete must not leave the closed session in the live list (#134889 TUI-19).

The Ink picker and the classic CLI read a delete's CAS tuple with ``session.resume``, which attaches a
viewer. When the owner refuses the delete (stale revision, read-only grant) nothing retired the
session, so ``closed_and_unviewed`` stayed false while that viewer was subscribed and the closed chat
reappeared in the live section until the client exited. The clients now detach the read's
subscription on a refusal; this pins the owner side of that contract over the real dispatch: the
refused delete reopens the session in the live list, and a plain ``session.detach`` of the read's
subscription puts it back as a closed, resumable history row with its original end stamp.
"""
from types import SimpleNamespace

import pytest


async def _owner(tmp_path, monkeypatch):
    from gateway import run
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from gateway.session_authority import initialize_session_authority

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(run, '_load_gateway_config', lambda: {'platform_toolsets': {'cli': []}})
    store = SessionStore(tmp_path / 'sessions', GatewayConfig())
    runner = SimpleNamespace(session_store=store, _session_db=store._db, adapters={}, _draining=False,
                             _cached_agent_for=lambda route: None)
    runner._adapter_for_source = lambda source: runner.adapters.get(source.platform)
    authority = await initialize_session_authority(runner, profile_id=str(tmp_path), instance_id='owner')
    return store._db, authority


def _viewer(authority, tmp_path, user='native'):
    from gateway.session_controls import AuthorityConnection
    return AuthorityConnection(authority, SimpleNamespace(write=lambda frame: None), {
        'provider': 'local', 'user_id': user, 'profile_id': str(tmp_path), 'instance_id': 'owner'})


async def _call(conn, method, **params):
    reply = await conn.dispatch({'id': 1, 'method': method, 'params': params})
    assert 'result' in reply, reply
    return reply['result']


async def _live_ids(conn):
    return [row['id'] for row in (await _call(conn, 'session.list'))['sessions']]


@pytest.mark.asyncio
async def test_detaching_the_reads_subscription_after_a_refused_delete_restores_the_closed_row(tmp_path, monkeypatch):
    db, authority = await _owner(tmp_path, monkeypatch)
    db.create_session('closed', source='tui', model='fake-model', cwd=str(tmp_path))
    db.append_message('closed', 'user', 'q')
    db.append_message('closed', 'assistant', 'a')
    viewer = _viewer(authority, tmp_path)
    first = await _call(viewer, 'session.resume', session_id='closed')
    await _call(viewer, 'session.detach', session_id='closed', subscription_id=first['subscription_id'],
                end_reason='tui_close')
    stamped = db.get_session('closed')
    assert stamped['end_reason'] == 'tui_close'
    picker = _viewer(authority, tmp_path)
    assert await _live_ids(picker) == []

    # The picker's sequence: a CAS read, then a delete the owner refuses (stale revision).
    read = await _call(picker, 'session.resume', session_id='closed')
    refused = await picker.dispatch({'id': 2, 'method': 'session.mutate', 'params': {
        'session_id': 'closed', 'request_id': 'req-1', 'expected_revision': read['revision'] + 1,
        'expected_generation': read['execution_generation'], 'operation': 'delete', 'payload': {}}})
    assert refused['error']['data']['reason'] == 'revision_conflict', refused
    assert await _live_ids(picker) == ['closed']  # the bug: the read's viewer reopened it

    out = await _call(picker, 'session.detach', session_id='closed', subscription_id=read['subscription_id'])
    assert out['detached'] is True
    assert await _live_ids(picker) == []
    row = db.get_session('closed')
    assert (row['ended_at'], row['end_reason']) == (stamped['ended_at'], 'tui_close')
    stored = await _call(picker, 'session.list', scope='stored')
    assert [r['id'] for r in stored['sessions']] == ['closed']


