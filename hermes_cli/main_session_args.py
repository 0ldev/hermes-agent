"""Owns the argv preprocessing that joins multi-word session names after ``-c``/``-r``.

Split out of ``hermes_cli/main.py``; ``main`` re-imports it so the
``hermes_cli.main._coalesce_session_name_args`` seam keeps working.
"""

from __future__ import annotations


def _coalesce_session_name_args(argv: list) -> list:
    """Join unquoted multi-word session names after -c/--continue and -r/--resume.

    ``hermes -c Pokemon Agent Dev`` → ``['-c', 'Pokemon Agent Dev']``; tokens
    are collected until the next flag (``-*``) or known top-level subcommand.
    """
    _SUBCOMMANDS = {
        "chat", "model", "gateway", "setup", "whatsapp", "whatsapp-cloud", "login", "logout",
        "auth", "status", "cron", "doctor", "config", "pairing", "skills", "tools", "trace", "mcp",
        "sessions", "insights", "update", "uninstall", "profile", "dashboard", "serve",
        "desktop", "gui", "honcho", "claw", "plugins", "security", "acp", "webhook", "peer",
        "memory", "dump", "debug", "backup", "import", "completion", "logs", "usage", "workflow",
    }
    _SESSION_FLAGS = {"-c", "--continue", "-r", "--resume"}

    result = []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token in _SESSION_FLAGS:
            result.append(token)
            i += 1
            # Collect subsequent non-flag, non-subcommand tokens as one name
            parts: list = []
            while (
                i < len(argv)
                and not argv[i].startswith("-")
                and argv[i] not in _SUBCOMMANDS
            ):
                parts.append(argv[i])
                i += 1
            if parts:
                result.append(" ".join(parts))
        else:
            result.append(token)
            i += 1
    return result
