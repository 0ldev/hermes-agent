"""Production-builder prefix and role controls for #137307.

Only external availability and runtime inputs are controlled; prompt renderers
and delegate toolset resolution stay real.
"""
from contextlib import nullcontext
from datetime import UTC, datetime
from os.path import commonprefix
from pathlib import Path
import socket

import pytest

from agent.delegation_context import delegated_child_context
from agent.prompt_builder import (
    DEFAULT_AGENT_IDENTITY, HERMES_AGENT_HELP_GUIDANCE, HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS,
    KANBAN_GUIDANCE, OPENAI_MODEL_EXECUTION_GUIDANCE, SESSION_SEARCH_GUIDANCE,
    SKILLS_GUIDANCE, STEER_CHANNEL_NOTE,
)
from agent.system_prompt import _skills_prompt, build_system_prompt_parts


@pytest.fixture
def agent_factory(monkeypatch, tmp_path):
    import hermes_time
    import tools.registry as registry_module
    from run_agent import AIAgent
    from tools import env_probe
    from tools.skills_sync import sync_skills

    home = tmp_path / "home"
    home.mkdir()
    cwd = tmp_path / "plain"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.delenv("TERMINAL_CWD", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setattr(hermes_time, "now", lambda: datetime(2026, 1, 15, 12, tzinfo=UTC))
    monkeypatch.setattr(registry_module, "_check_fn_cached", lambda _fn: True)
    monkeypatch.setattr(env_probe, "get_environment_probe_line", lambda **_kw: "")

    def refuse_network(*_args, **_kwargs):
        raise OSError("network disabled for prompt-builder control")

    monkeypatch.setattr(socket.socket, "connect", refuse_network)
    monkeypatch.setattr(socket, "create_connection", refuse_network)
    monkeypatch.setattr(socket, "getaddrinfo", refuse_network)
    sync_skills(quiet=True)
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
    agents = []

    def make(**overrides):
        options = dict(
            model="anthropic/claude-sonnet-4.5", api_key="inspect-only",
            base_url="https://openrouter.ai/api/v1", provider="openrouter",
            quiet_mode=True, save_trajectories=False, platform="cli",
            skip_context_files=True, skip_background_review=True,
            session_id="20260115_120000_prompt_control", enabled_toolsets=["hermes-cli"],
        )
        options.update(overrides)
        agent = AIAgent(**options)
        agents.append(agent)
        return agent

    yield make
    for agent in reversed(agents):
        agent.close()


def _joined(parts):
    return "\n\n".join(parts[tier] for tier in ("stable", "context", "volatile") if parts[tier])


def test_shared_skills_index_precedes_memory_guidance_divergence(agent_factory, record_property):
    """A memory exposure change must not discard an identical skills index behind it."""
    toolsets = ["terminal", "file", "web", "skills", "session_search", "memory"]
    full = agent_factory(enabled_toolsets=toolsets)
    restricted = agent_factory(enabled_toolsets=toolsets, disabled_toolsets=["memory"])
    assert "memory" in full.valid_tool_names
    assert "memory" not in restricted.valid_tool_names
    assert full.valid_tool_names == restricted.valid_tool_names | {"memory"}
    index = _skills_prompt(full).strip()
    assert index and "<available_skills>" in index
    assert _skills_prompt(restricted).strip() == index
    full_parts = build_system_prompt_parts(full)
    restricted_parts = build_system_prompt_parts(restricted)
    assert full_parts["stable"] == restricted_parts["stable"]
    assert full_parts["context"] == restricted_parts["context"]
    full_prompt, restricted_prompt = _joined(full_parts), _joined(restricted_parts)
    shared = commonprefix([full_prompt, restricted_prompt])
    record_property("shared_prefix_chars", len(shared))
    record_property("skills_index_chars", len(index))
    assert index in shared
    assert full_parts["volatile"].startswith(index)
    assert restricted_parts["volatile"].startswith(index)
    assert "Memory is the narrow exception" in full_parts["volatile"]
    assert "Memory is the narrow exception" not in restricted_parts["volatile"]


@pytest.mark.parametrize("model, requested, shared_block", [
    pytest.param(
        "anthropic/claude-sonnet-4.5", None, STEER_CHANNEL_NOTE,
        id="claude-inherited",
    ),
    pytest.param(
        "anthropic/claude-sonnet-4.5", ["terminal", "file", "web"],
        commonprefix([HERMES_AGENT_HELP_GUIDANCE, HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS]),
        id="claude-terminal-file-web",
    ),
    pytest.param(
        "openai/gpt-5", ["skills", "web"],
        OPENAI_MODEL_EXECUTION_GUIDANCE.split("\n\n<mandatory_tool_use>", 1)[0],
        id="gpt-skills-web",
    ),
])
def test_resolved_leaf_guidance_is_tool_correct(
    agent_factory, model, requested, shared_block, record_property,
):
    """Real leaves share the common scaffold through a semantic block, possibly further."""
    from tools.delegate_tool_toolsets import DELEGATE_BLOCKED_TOOLS, _resolve_child_toolsets

    parent = agent_factory(model=model, skip_context_files=False)
    enabled, disabled = _resolve_child_toolsets(parent, requested, "leaf")
    with delegated_child_context():
        child = agent_factory(
            model=model, enabled_toolsets=enabled, disabled_toolsets=disabled,
            platform="subagent", side_agent=True, skip_context_files=True, skip_memory=True,
        )
    assert not (child.valid_tool_names & DELEGATE_BLOCKED_TOOLS)
    required_tool = "terminal" if requested is None or "terminal" in requested else "skill_view"
    assert required_tool in child.valid_tool_names
    rendered = []
    for agent in (parent, child):
        parts = build_system_prompt_parts(agent)
        for guidance, tool in (
            ("Memory is the narrow exception", "memory"),
            (SESSION_SEARCH_GUIDANCE, "session_search"),
            (SKILLS_GUIDANCE, "skill_manage"),
        ):
            assert guidance not in parts["stable"]
            assert guidance not in parts["context"]
            assert parts["volatile"].count(guidance) == int(tool in agent.valid_tool_names)
        assert KANBAN_GUIDANCE not in _joined(parts)
        rendered.append(_joined(parts))
    shared = commonprefix(rendered)
    assert shared.startswith(DEFAULT_AGENT_IDENTITY)
    assert shared_block and all(shared_block in prompt for prompt in rendered)
    # Require the whole common block before any divergence. This is a lower
    # bound, so relocating later differences or making the prompts equal is fine.
    minimum_boundary = max(prompt.index(shared_block) + len(shared_block) for prompt in rendered)
    boundary = len(shared)
    assert boundary >= minimum_boundary
    record_property("minimum_shared_prefix_chars", minimum_boundary)
    record_property("shared_prefix_chars", boundary)
    record_property("parent_boundary", rendered[0][boundary:boundary + 180])
    record_property("child_boundary", rendered[1][boundary:boundary + 180])


@pytest.mark.parametrize("role", ["interactive", "worker", "child"])
def test_kanban_role_guidance_stays_in_stable_tier(agent_factory, monkeypatch, role):
    """Inheriting a worker's environment must not give a leaf its task protocol."""
    if role != "interactive":
        monkeypatch.setenv("HERMES_KANBAN_TASK", "t_prompt_worker")
    with delegated_child_context() if role == "child" else nullcontext():
        agent = agent_factory(enabled_toolsets=["kanban"], side_agent=role == "child")
        parts = build_system_prompt_parts(agent)
    assert "kanban_show" in agent.valid_tool_names
    assert parts["stable"].count(KANBAN_GUIDANCE) == int(role == "worker")
    assert KANBAN_GUIDANCE not in parts["context"]
    assert KANBAN_GUIDANCE not in parts["volatile"]
