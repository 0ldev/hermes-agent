"""Content search inside PDFs and Office documents for ``search_files``.

ripgrep skips binary files, so a content search over a folder of paperwork came
back empty while ``read_file`` could extract the very text being searched for
(#101427). This searches the extracted text of the documents in scope with the
same regex, and reports line numbers that match ``read_file`` on the same path,
so ``read_file(path, offset=<line>)`` opens the passage.

The shape follows Perplexity Computer's Projects workspace (Oct 2026 engineering
post "Building shared workspaces for people and agents"): parsed text is kept
outside the files, keyed by the source document's content hash, and agents search
it with their ordinary file tools instead of a semantic index; documents whose
text cannot be produced are named, never silently dropped.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Optional

from tools import interrupt as tool_interrupt
from tools.read_extract import (
    ANYDOC_EXTENSIONS, EXTRACTABLE_EXTENSIONS, ExtractionError, extract_document_bytes,
    is_extractable_document)

logger = logging.getLogger(__name__)

# .ipynb is JSON text rg already reads; SQLite renders a schema dump, not prose.
SEARCHABLE_DOCUMENT_EXTENSIONS = frozenset(
    (EXTRACTABLE_EXTENSIONS | ANYDOC_EXTENSIONS) - {".ipynb", ".db", ".sqlite", ".sqlite3"})
MAX_SEARCH_DOCUMENTS = 50
MAX_SEARCH_DOCUMENT_BYTES = 20 * 1024 * 1024
EXTRACTION_BUDGET_SECONDS = 20.0
MAX_DOCUMENT_MATCHES = 50
_SNIPPET_RADIUS = 120
_HINT_MAX_FILES = 10
_CACHE_MAX_CHARS = 32_000_000

# sha256(document bytes) -> (text, error). Keyed by content, so an edited file is a new
# entry and a copy shares one; failures are cached too (a scanned PDF is not re-parsed
# on every search). In-memory only: extracted text of user documents is never persisted.
_cache: OrderedDict[str, tuple[str, str]] = OrderedDict()
_cache_chars = 0
_cache_lock = threading.Lock()


def _cached_extract(data: bytes, path: str) -> tuple[str, str]:
    global _cache_chars
    key = hashlib.sha256(data).hexdigest()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    try:
        entry = (extract_document_bytes(data, path), "")
    except ExtractionError as exc:
        entry = ("", str(exc).split(". ")[0][:160] or "extraction failed")
    with _cache_lock:
        if key not in _cache:
            _cache[key] = entry
            _cache_chars += len(entry[0])
            while _cache_chars > _CACHE_MAX_CHARS and len(_cache) > 1:
                _, (old_text, _) = _cache.popitem(last=False)
                _cache_chars -= len(old_text)
    return entry


def _glob_admits(path: str, file_glob: Optional[str]) -> bool:
    if not file_glob:
        return True
    target = path.replace("\\", "/") if "/" in file_glob else os.path.basename(path)
    return fnmatch.fnmatch(target, file_glob) or fnmatch.fnmatch(target, f"*/{file_glob}")


def _glob_can_select_documents(file_glob: Optional[str]) -> bool:
    """False only when ``file_glob`` pins an extension no document has (``*.py``), so a
    narrowed code search skips the extra document walk."""
    tail = (file_glob or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    if not re.search(r"\.\w+$", tail) or "{" in tail:
        return True
    return any(fnmatch.fnmatchcase(f"x{ext}", tail) for ext in SEARCHABLE_DOCUMENT_EXTENSIONS)


def _snippet(line: str, match: re.Match) -> str:
    start, end = match.start(), match.end()
    lo, hi = max(0, start - _SNIPPET_RADIUS), min(len(line), end + _SNIPPET_RADIUS)
    return ("…" if lo else "") + line[lo:hi].strip() + ("…" if hi < len(line) else "")


def _line_hits(text: str, regex: re.Pattern) -> list[tuple[int, str]]:
    """(1-based line, snippet) per matching line, numbered exactly as read_file numbers it."""
    lines = text.splitlines()
    if "\n" in regex.pattern or "\\n" in regex.pattern:
        hits, seen = [], set()
        for m in regex.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            if line_no not in seen and line_no <= len(lines):
                seen.add(line_no)
                hits.append((line_no, m.group(0).replace("\n", " ")[:2 * _SNIPPET_RADIUS]))
        return hits
    return [(i, _snippet(line, m)) for i, line in enumerate(lines, 1)
            if (m := regex.search(line)) is not None]


def search_documents(file_ops: Any, path: str, pattern: str, file_glob: Optional[str],
                     output_mode: str, *, admit: Callable[[str], bool],
                     redact: Callable[[str, str], str]) -> dict:
    """Search the extracted text of documents under ``path``; return keys for the
    search_files result (empty dict when no document is in scope).

    ``admit`` is the read-block policy (credential/secret paths stay unsearched) and
    ``redact`` the same secret scrubber content matches get.
    """
    if not _glob_can_select_documents(file_glob):
        return {}
    try:
        regex = re.compile(pattern)
    except re.error:
        return {}
    try:
        candidates, more = file_ops.list_documents(path, SEARCHABLE_DOCUMENT_EXTENSIONS,
                                                   MAX_SEARCH_DOCUMENTS)
    except Exception:
        logger.debug("document listing failed for %s", path, exc_info=True)
        return {}
    docs = [d for d in candidates if _glob_admits(d, file_glob) and admit(d)]
    if not docs:
        return {}

    hits: dict[str, list[tuple[int, str]]] = {}
    skipped: dict[str, str] = {}
    deadline = time.monotonic() + EXTRACTION_BUDGET_SECONDS
    for doc in docs:
        if tool_interrupt.is_interrupted() or time.monotonic() > deadline:
            skipped[doc] = "time budget reached"
            continue
        if not is_extractable_document(doc):
            skipped[doc] = "converter unavailable (run `hermes pm repair`)"
            continue
        raw = file_ops.read_file_bytes(doc, max_bytes=MAX_SEARCH_DOCUMENT_BYTES)
        if raw.error or raw.base64_content is None:
            skipped[doc] = (raw.error or "unreadable").split(" (")[0]
            continue
        text, error = _cached_extract(base64.b64decode(raw.base64_content), doc)
        if error:
            skipped[doc] = error
            continue
        found = _line_hits(text, regex)
        if found:
            hits[doc] = found

    out: dict[str, Any] = {}
    total = sum(len(v) for v in hits.values())
    if hits:
        if output_mode == "files_only":
            out["document_files"] = list(hits)
        elif output_mode == "count":
            out["document_counts"] = {doc: len(v) for doc, v in hits.items()}
        else:
            rows, shown = [], 0
            for doc, found in hits.items():
                if shown >= MAX_DOCUMENT_MATCHES:
                    break
                rows.append(doc)
                for line_no, snippet in found[:MAX_DOCUMENT_MATCHES - shown]:
                    rows.append(f"  {line_no}: {redact(doc, snippet)}")
                    shown += 1
            out["document_matches"] = "\n".join(rows)
        out["document_matches_note"] = (
            f"{total} match(es) in {len(hits)} PDF/Office document(s), searched in their "
            "extracted text (ripgrep cannot read these files). Format: path, then "
            "'<line>: <snippet>' rows; line numbers match read_file on that path, so "
            "read_file(path, offset=<line>) opens the passage."
            + (f" Showing the first {MAX_DOCUMENT_MATCHES}." if total > MAX_DOCUMENT_MATCHES else ""))
    if skipped or more:
        names = list(skipped)[:_HINT_MAX_FILES]
        reasons = sorted(set(skipped.values()))[:3]
        parts = []
        if skipped:
            parts.append(
                f"{len(skipped)} document(s) in scope could NOT be searched "
                f"({'; '.join(reasons)}): {', '.join(names)}"
                + (" …" if len(skipped) > len(names) else "") + ".")
        if more:
            parts.append(
                f"More than {MAX_SEARCH_DOCUMENTS} documents are in scope; only the first "
                f"{MAX_SEARCH_DOCUMENTS} were searched. Narrow path or file_glob to reach the rest.")
        parts.append("Do not conclude the text is absent from documents that were not searched.")
        out["_documents_not_searched"] = " ".join(parts)
    return out
