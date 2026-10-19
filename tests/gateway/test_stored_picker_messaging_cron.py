"""TUI-8 listing half (#134889): the Ink ``/resume`` picker's stored feed offers stored messaging and
cron sessions the viewer may open, and resuming each one succeeds.

Built on the real paths: a cron run is created through ``session_cron.operation('submit')`` and
settled through the runtime store; a Telegram lane is registered by a previous process
(``SessionAuthority.register``). The picker is read through ``AuthorityConnection.dispatch``.
"""
import asyncio
from types import SimpleNamespace

import pytest


async def _setup(tmp_path, monkeypatch):
    from cron import jobs
    from gateway import run, session_cron
    from gateway.config import GatewayConfig, Platform
    from gateway.session import SessionSource, SessionStore
    from gateway.session_authority import initialize_session_authority
    from gateway.session_contract import SessionRef
    from gateway.session_controls import AuthorityConnection
    from hermes_state_runtime import claim_session_input, settle_session_input

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(jobs, 'get_job', lambda jid: {'id': jid, 'name': 'Nightly digest', 'prompt': 'p',
                                                      'model': 'm'})
    monkeypatch.setattr(run, '_load_gateway_config', lambda: {'model': {}, 'platform_toolsets': {'cli': []}})

    def runner():
        store = SessionStore(tmp_path / 'sessions', GatewayConfig())
        r = SimpleNamespace(session_store=store, _session_db=store._db, adapters={}, _draining=False,
                            _cached_agent_for=lambda route: None)
        r._adapter_for_source = lambda source: r.adapters.get(source.platform)
        r._restored_source = lambda entry: entry.origin
        return r

    warm = await initialize_session_authority(runner(), profile_id=str(tmp_path), instance_id='owner')
    warm._schedule = lambda ref: None
    session_cron.bind_owner(warm)
    try:
        submitted = await session_cron.operation(warm, 'submit', {'job_id': 'job', 'request_id': 'r1',
                                                                   'extra_prompt': None})
    finally:
        session_cron.unbind_owner(warm)
    cron_sid = submitted['session_id']
    row = claim_session_input(warm.db, epoch=warm.epoch, session_id=cron_sid)
    settle_session_input(warm.db, epoch=warm.epoch, admission_id=row['admission_id'],
                         generation=row['generation'], outcome='completed',
                         result={'result': {'cron_result': [True, 'doc', 'answer', None]}, 'usage': {}})
    warm.db.end_session(cron_sid, 'cron_complete')
    lane = warm.register(SessionSource(platform=Platform.TELEGRAM, chat_id='4242', user_id='u-4242',
                                       chat_type='dm', chat_name='Ana'))
    warm.db.append_message(lane.session_id, 'user', 'hi from telegram')
    warm.db.append_message(lane.session_id, 'assistant', 'hello ana')
    warm.db.set_session_title(lane.session_id, 'Telegram chat')

    # A restart: a fresh owner with nothing of the messaging lane published.
    cold = await initialize_session_authority(runner(), profile_id=str(tmp_path), instance_id='owner')
    native = AuthorityConnection(cold, object(), {'provider': 'local', 'user_id': 'native',
        'profile_id': str(tmp_path), 'instance_id': 'owner'}, operator=True)
    return SimpleNamespace(cold=cold, native=native, cron_sid=cron_sid, lane_sid=lane.session_id,
                           ref=SessionRef)


async def _call(connection, method, **params):
    return await connection.dispatch({'id': 1, 'method': method, 'params': params})


def test_stored_picker_lists_messaging_and_cron_rows_and_each_resumes(tmp_path, monkeypatch):
    async def probe():
        env = await _setup(tmp_path, monkeypatch)
        stored = await _call(env.native, 'session.list', scope='stored', limit=200)
        live = await _call(env.native, 'session.list', limit=200)
        assert 'result' in stored, stored
        offered = {r['id'] for r in stored['result']['sessions']} | {r['id'] for r in live['result']['sessions']}
        assert env.lane_sid in offered, (stored, live)
        assert env.cron_sid in offered, (stored, live)
        row = next(r for r in stored['result']['sessions'] if r['id'] == env.lane_sid)
        assert row['source'] == 'telegram' and row['title'] == 'Telegram chat'
        for sid in (env.lane_sid, env.cron_sid):
            resumed = await _call(env.native, 'session.resume', session_id=sid)
            assert 'result' in resumed, (sid, resumed)

    asyncio.run(probe())


def test_stored_picker_never_offers_messaging_rows_to_a_non_native_transport(tmp_path, monkeypatch):
    async def probe():
        from gateway.session_controls import AuthorityConnection
        env = await _setup(tmp_path, monkeypatch)
        remote = AuthorityConnection(env.cold, object(), {'provider': 'remote', 'user_id': 'remote',
            'profile_id': str(tmp_path), 'instance_id': 'owner'}, operator=True)
        stored = await _call(remote, 'session.list', scope='stored', limit=200)
        assert stored['result']['sessions'] == []
        assert env.lane_sid not in env.cold.sessions  # listing never mounts

    asyncio.run(probe())


def test_stored_picker_lists_a_compressed_messaging_lane_under_its_root(tmp_path):
    """A messaging lane that compressed once is listed by its lineage root, the id session.resume
    mounts (list_sessions_rich projects the root onto its tip, so ``row['id']`` is the tip)."""
    async def probe():
        from gateway.session_authority import initialize_session_authority
        from gateway.session_controls import AuthorityConnection
        from tests.gateway.test_authority_cold_route_recovery import _Runner, _cold, _source
        from tests.gateway.test_messaging_control_read import _compressed_lane
        root, _ = await _compressed_lane(tmp_path)
        warm2 = await initialize_session_authority(_Runner(tmp_path), profile_id='fixture', instance_id='warm2')
        plain = warm2.register(_source('weixin', chat_id='wx-2')).session_id
        warm2.db.append_message(plain, 'user', 'hello')
        cold = await _cold(tmp_path)
        native = AuthorityConnection(cold.authority, object(), {'provider': 'local', 'user_id': 'native',
            'profile_id': 'fixture', 'instance_id': 'cold'}, operator=True)
        stored = await _call(native, 'session.list', scope='stored', limit=200)
        assert 'result' in stored, stored
        rows = {r['id']: r for r in stored['result']['sessions']}
        assert plain in rows, rows  # control: an uncompressed lane
        assert root in rows and 'seg-1' not in rows, rows
        assert rows[root]['session_id'] == root
        resumed = await _call(native, 'session.resume', session_id=root)
        assert 'result' in resumed, resumed

    asyncio.run(probe())
