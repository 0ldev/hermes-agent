import { isMessagingSource } from '@/lib/session-source'
import type { SessionInfo } from '@/types/hermes'

import { $projectTree } from './project-tree'
import { ownerLookupSessionRows, sessionMatchesStoredId } from './session'

/** The best cached row for a stored session id, across every slice the sidebar
 *  has loaded (#76535): the owner-lookup rows (recents + cron + messaging +
 *  unlisted-draft/hidden stubs) and the project tree (a tile's session is
 *  often older than the paginated recents page, so the tree is the only
 *  loaded copy). Never a by-id fetch — a computed must stay synchronous. */
export function focusedSessionRow(storedSessionId: string): SessionInfo | undefined {
  return (
    ownerLookupSessionRows().find(s => sessionMatchesStoredId(s, storedSessionId)) ??
    $projectTree
      .get()
      .flatMap(project => [
        ...(project.previewSessions ?? []),
        ...project.repos.flatMap(repo => repo.groups.flatMap(group => group.sessions))
      ])
      .find(s => sessionMatchesStoredId(s, storedSessionId))
  )
}

/** A loaded row for *storedId* comes from a messaging platform (RT-18, #139017).
 *  Those conversations deliver their own completion to their originating
 *  platform, so a Desktop observer is not an unread recipient of it. */
export function isExternalMessagingSession(storedId: string): boolean {
  const row = ownerLookupSessionRows().find(session => sessionMatchesStoredId(session, storedId))

  return isMessagingSource(row?.source)
}
