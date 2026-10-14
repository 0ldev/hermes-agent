"""Pull diagnostics are requested only from a server that serves them (#126949).

A push-only server asked for ``textDocument/diagnostic`` answers -32601 at once, and the wait loop used
to re-issue the pull on every pass: thousands of rejected requests per edited file.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from agent.lsp.client import LSPClient

MOCK_SERVER = str(Path(__file__).parent / "_mock_lsp_server.py")


def _client(workspace: Path, script: str, **env_extra: str) -> LSPClient:
    env = {"MOCK_LSP_SCRIPT": script, "PYTHONPATH": os.environ.get("PYTHONPATH", ""), **env_extra}
    return LSPClient(server_id=f"mock-{script}", workspace_root=str(workspace),
                     command=[sys.executable, MOCK_SERVER], env=env, cwd=str(workspace))


async def _requests_during_wait(client: LSPClient, path: Path, budget: float) -> int:
    version = await client.open_file(str(path))
    before = client._next_id  # the client's own JSON-RPC id counter: one per request sent
    await client.wait_for_diagnostics(str(path), version, timeout=budget)
    return client._next_id - before


@pytest.mark.asyncio
async def test_rejected_pull_is_not_reissued(tmp_path: Path):
    """``silent`` advertises pull, rejects it with -32601 and never pushes: the worst case."""
    path = tmp_path / "x.py"
    path.write_text("x = 1\n", encoding="utf-8")
    client = _client(tmp_path, "silent")
    await client.start()
    try:
        assert await _requests_during_wait(client, path, 1.0) == 1
        assert await _requests_during_wait(client, path, 0.3) == 0  # latched for the process
    finally:
        await client.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(("mode", "pulls"), [("static", True), ("dynamic", True), ("none", False)])
async def test_pull_follows_server_capability(tmp_path: Path, mode: str, pulls: bool):
    """``diagnosticProvider`` at initialize or a dynamic registration enables pull; neither keeps it off."""
    path = tmp_path / "x.py"
    path.write_text("x = 1\n", encoding="utf-8")
    client = _client(tmp_path, "clean", MOCK_LSP_PULL=mode)
    await client.start()
    try:
        for _ in range(40):  # the dynamic registration arrives just after `initialized`
            if client._pull_supported == pulls:
                break
            await asyncio.sleep(0.05)
        assert client._pull_supported is pulls
        assert await _requests_during_wait(client, path, 2.0) == int(pulls)
    finally:
        await client.shutdown()
