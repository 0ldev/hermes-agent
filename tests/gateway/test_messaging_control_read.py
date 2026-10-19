"""RT-18 (#134889, #139017): Desktop opening a messaging-channel session (WeChat, Telegram, ...) polls
``session.control.read``; it failed with ``stale_generation``.

``_require_current_route`` compared the lane's routing entry to ``physical_target``, which for a
messaging row is the row id itself. A lane that compressed once routes to its continuation while the
viewer mounts the lineage root (``messaging_owner_ref``), so a CURRENT lane read as stale; a row the
lane moved past (``/new``) was refused too. Control is a read of the persisted goal/loop/heartbeat
of the conversation's own transcript, never a live object of the route, so it needs no route check.
Real authority, real SQLite store, real compression publish, real dispatch.
"""
import json

import pytest

from tests.gateway.test_authority_cold_route_recovery import _cold, _source


async def _compressed_lane(tmp_path):
    from gateway.session_authority import initialize_session_authority
    from tests.gateway.test_authority_cold_route_recovery import _Runner
    runner = _Runner(tmp_path)
    warm = await initialize_session_authority(runner, profile_id='fixture', instance_id='warm')
    source = _source('weixin', chat_id='wx-1')
    root = warm.register(source).session_id
    route = runner.session_store._generate_session_key(source)
    db = warm.db
    db.append_message(root, 'user', 'first')
    db.publish_compression_child(parent_session_id=root, child_session_id='seg-1', source='weixin',
                                 messages=[{'role': 'user', 'content': 'summary'}],
                                 require_compression_lease=False)
    assert runner.session_store.advance_compression_session(route, root, 'seg-1') is not None
    db.record_gateway_session_peer('seg-1', source='weixin', user_id=source.user_id, session_key=route,
                                   chat_id=source.chat_id, chat_type=source.chat_type,
                                   origin_json=json.dumps(source.to_dict()))
    return root, route


async def _viewer(tmp_path):
    from gateway.session_controls import AuthorityConnection
    cold = await _cold(tmp_path)
    return cold, AuthorityConnection(cold.authority, object(), {
        'provider': 'local', 'user_id': 'viewer', 'profile_id': 'fixture', 'instance_id': 'cold',
        'capabilities': ['session:read']})


async def _call(connection, method, **params):
    return await connection.dispatch({'id': 1, 'method': method, 'params': params})


@pytest.mark.asyncio
async def test_control_read_of_a_compressed_messaging_lane_is_its_persisted_controls(tmp_path):
    root, _ = await _compressed_lane(tmp_path)
    cold, viewer = await _viewer(tmp_path)
    # A goal the lane set on its current transcript (gateway goals key on the physical session).
    from hermes_cli.goals import GoalState
    cold.authority.db.set_meta('goal:seg-1', GoalState(goal='ship it').to_json())
    resumed = await _call(viewer, 'session.resume', session_id='seg-1')
    assert resumed.get('result', {}).get('session_id') == root, resumed
    read = await _call(viewer, 'session.control.read', session_id=root)
    assert 'result' in read, read
    assert read['result']['control']['goal']['title'] == 'ship it'


@pytest.mark.asyncio
async def test_control_read_of_a_messaging_row_its_lane_moved_past_is_read_only_not_refused(tmp_path):
    root, _ = await _compressed_lane(tmp_path)
    cold, viewer = await _viewer(tmp_path)
    assert 'result' in await _call(viewer, 'session.resume', session_id=root)
    # /new on the lane, then its next inbound publishes the newer conversation.
    cold.authority.runner.session_store.reset_session(cold.authority.sessions[root].route)
    other = cold.authority.register(_source('weixin', chat_id='wx-1')).session_id
    assert other != root and cold.authority.sessions[root].superseded
    read = await _call(viewer, 'session.control.read', session_id=root)
    assert 'result' in read, read
    assert read['result']['control']['goal'] is None


@pytest.mark.asyncio
async def test_live_object_reads_of_a_moved_messaging_row_stay_refused(tmp_path):
    """The route check still guards what it is for: the route's live agent/processes belong to the
    newer conversation, so a moved row never borrows them."""
    root, _ = await _compressed_lane(tmp_path)
    cold, viewer = await _viewer(tmp_path)
    assert 'result' in await _call(viewer, 'session.resume', session_id=root)
    route = cold.authority.sessions[root].route
    cold.authority.runner.session_store.reset_session(route)
    cold.authority.register(_source('weixin', chat_id='wx-1'))
    read = await _call(viewer, 'subagent.list', session_id=root)
    assert read.get('error', {}).get('message') == 'stale_generation', read
