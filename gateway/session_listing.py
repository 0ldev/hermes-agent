"""Read-only native picker history; enumeration never adopts a transcript."""
from hermes_state_local_migration import validate_legacy_row
from hermes_state_mutation_binding import authorize_history
from hermes_state_runtime import RuntimeStoreError


_LOCAL_PICKER_SOURCES = ('cli', 'tui', 'gui', 'desktop', 'local', 'cron')


def _picker_sources():
    """Local surfaces plus every messaging platform: the classic picker listed all human sessions.
    ``cron`` rows are canonical local sessions (``session_cron``): they list through the closed-session
    rule, so only a principal ``authorize`` lets read them (an operator transport) sees them."""
    from gateway.config import Platform
    return [*_LOCAL_PICKER_SOURCES, *(p.value for p in Platform if p not in (Platform.LOCAL, Platform.API_SERVER))]


_PICKER_SOURCES = _picker_sources()


def stored_picker_sessions(authority, actor, *, limit, include_hidden=False):
    """Offer legacy local rows only to the same native transport that may resume them.

    Canonical sessions are already in the live feed. Old local rows have no policy
    receipt until explicit resume; listing them must not claim or restore anything.
    """
    if actor.profile_id != authority.profile_id:
        raise RuntimeStoreError('profile_mismatch')
    if (getattr(authority, '_native_legacy_transports', {}).get(actor.transport_id) != actor
            or not {'session:read', 'session:create'} <= actor.capabilities):
        return {'sessions': [], 'scope': 'stored'}
    db = authority.db
    sessions, offset, seen = [], 0, set()
    while len(sessions) < limit:
        rows = db.list_sessions_rich(sources=_PICKER_SOURCES, limit=200, offset=offset,
            order_by_last_active=True, compact_rows=True, include_hidden=include_hidden)
        for row in rows:
            sid = db.get_compression_tip(row['id']) or row['id']
            tip = db.get_session(sid)
            if tip is None:
                continue
            if row['source'] not in _LOCAL_PICKER_SOURCES:
                # A stored messaging conversation (TUI-8): main's picker listed it, and
                # ``session.resume`` mounts it from its own origin (session_route_recovery).
                messaging = _messaging_row(authority, row, sid, tip)
                if messaging is not None:
                    sessions.append(messaging)
                    if len(sessions) == limit:
                        break
                continue
            closed = _closed_local_session(authority, actor, row, tip)
            if closed is not None:
                if closed['id'] not in seen:
                    seen.add(closed['id'])
                    sessions.append(closed)
                if len(sessions) == limit:
                    break
                continue
            try:
                validate_legacy_row(db, tip, subject=actor.subject)
                with db._read_ctx() as conn:
                    if not authorize_history(conn, actor, sid):
                        continue
            except RuntimeStoreError as exc:
                if exc.reason not in {'not_found', 'permission_denied'}:
                    raise
                continue
            sessions.append({'id': row['id'], 'session_id': sid, 'resolved_id': sid,
                'title': row.get('title') or '', 'source': tip['source'],
                'started_at': row.get('started_at'), 'message_count': row.get('message_count', 0),
                'model': tip.get('model'), 'running': False})
            if len(sessions) == limit:
                break
        if len(rows) < 200:
            break
        offset += len(rows)
    return {'sessions': sessions, 'scope': 'stored'}


def _messaging_row(authority, row, sid, tip):
    """The picker row of a cold messaging lineage ``session.resume`` mounts; None when it is already
    live (the live feed lists it) or is not one this profile's route recovery would mount.

    ``list_sessions_rich`` projects a compressed lineage onto its tip, so ``row['id']`` is the tip;
    the lane is owned, mounted and resumed by its lineage root (``messaging_owner_ref``)."""
    from gateway.session_route_recovery import routed_row_platform
    root = row.get('_lineage_root_id') or row['id']
    if root in authority.sessions or routed_row_platform(authority, authority.db.get_session(root)) is None:
        return None
    return {'id': root, 'session_id': root, 'resolved_id': root,
            'title': tip.get('title') or row.get('title') or '', 'source': row['source'],
            'started_at': row.get('started_at'), 'message_count': row.get('message_count', 0),
            'model': tip.get('model'), 'running': False}


def _closed_local_session(authority, actor, row, tip):
    """A canonical local session (created here, or adopted from main) its last viewer closed: main's
    picker listed it as resumable. None for anything else, including a session another principal owns."""
    from gateway.session_contract import SessionRef
    from gateway.session_local_close import closed_and_unviewed
    owner = tip.get('chat_id')
    live = authority.sessions.get(owner) if owner else None
    if live is None:
        return None
    try:
        handle = authority._handle(SessionRef(authority.profile_id, owner))
        authority.authorize(actor, handle.ref, 'session:read')
    except RuntimeStoreError:
        return None
    if not closed_and_unviewed(authority, owner, handle):
        return None
    return {'id': owner, 'session_id': owner, 'resolved_id': owner, 'title': tip.get('title') or row.get('title') or '',
            'source': tip['source'], 'started_at': row.get('started_at'),
            'message_count': row.get('message_count', 0), 'model': tip.get('model'), 'running': False}
