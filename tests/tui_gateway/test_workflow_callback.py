"""The gateway's ``workflow`` callback plumbing: the renderer-backed ``workflow`` tool seam.

Split out of ``test_tui_gateway_server.py`` (over its FILE_LINES cap): the
workflow-callback tests added with the Workflows plugin, plus the contract that
every callback ``_agent_cbs()`` emits is a parameter the agent accepts.
"""

import inspect

from tui_gateway import server


def test_workflow_callback_blocks_on_the_canvas(monkeypatch):
    """The `workflow` tool reaches the Workflows plugin the same way every other
    renderer-backed tool reaches its surface: one blocking request, payload
    forwarded whole."""
    captured = {}

    def fake_send(method, sid, params, *, timeout, qids=None):
        captured.update(method=method, sid=sid, params=params, timeout=timeout, qids=qids)
        return {"value": '{"workflow": {"id": "w1"}}'}

    from tui_gateway import server_requests

    monkeypatch.setattr(server_requests, "send", fake_send)

    ops = [{"tool": "graph_add_step", "args": {"kind": "agent"}}]
    result = server._agent_cbs("sid-1")["workflow_callback"]({"action": "edit", "ops": ops})

    assert result == '{"workflow": {"id": "w1"}}'
    assert captured["method"] == "workflow"
    assert captured["sid"] == "sid-1"
    assert captured["params"] == {"action": "edit", "ops": ops}


def test_every_gateway_callback_is_one_the_agent_accepts():
    """_agent_cbs() is splatted into AIAgent(**cbs), so a callback added to the
    gateway without a matching parameter on the agent doesn't fail at import or
    typecheck — it fails at agent build, as 'unexpected keyword argument', on
    the user's first message. Adding a renderer-backed tool means touching five
    files; this is the one seam between them that nothing else checks."""
    import run_agent

    accepted = inspect.signature(run_agent.AIAgent.__init__).parameters
    emitted = server._agent_cbs("sid-1").keys()

    assert not [name for name in emitted if name not in accepted]
