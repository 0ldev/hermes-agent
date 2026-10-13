import type {
  RelayEvent,
  TraceDoc,
  TracePhase,
  TraceSpan,
  TraceSpanKind,
  TraceSpanStatus,
  TraceTurnSummary
} from '@/store/trace'

// Scope names Hermes gives its own Relay scopes (agent/relay_runtime.py).
const SESSION_SCOPE = 'hermes.session'
const TURN_SCOPE = 'hermes.turn'
const LOGICAL_LLM_SCOPE = 'hermes.logical_llm_call'
const TURN_INPUT_MARK = 'hermes.turn.input'
// Streamed model output (hermes_cli/observability/relay_traces.py): Relay marks attach only to
// scopes, so they sit on the call's parent scope and name the call by `llm_uuid`.
const FIRST_TOKEN_MARK = 'hermes.llm.first_token'
const STREAM_MARK = 'hermes.llm.stream'
const SPAWNED_BY_KEY = 'hermes.spawned_by_tool_call_id'
const DELEGATE_TOOL = 'delegate_task'

export interface TraceLabels {
  llmCall: string
  session: string
  subagent: string
  turn: string
}

const KIND_BY_CATEGORY: Record<string, TraceSpanKind> = { agent: 'AGENT', llm: 'LLM', tool: 'TOOL' }

type Json = Record<string, unknown>

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function relayEventSeconds(event: RelayEvent): number {
  const ms = Date.parse(event.timestamp)

  return Number.isFinite(ms) ? ms / 1000 : 0
}

function pretty(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function spanStatus(end: RelayEvent | undefined): TraceSpanStatus {
  if (!end) {
    return 'running'
  }

  const outcome = str(obj(end.data).outcome)

  if (obj(end.metadata)['otel.status_code'] === 'ERROR' || outcome === 'failed') {
    return 'error'
  }

  return outcome === 'cancelled' || obj(end.metadata)['hermes.status'] === 'abandoned' ? 'unset' : 'ok'
}

/** What the inspector shows: the model, tokens and payload Relay recorded for the span. */
function spanAttributes(start: RelayEvent, end: RelayEvent | undefined): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  const profile = { ...obj(start.category_profile), ...obj(end?.category_profile) }

  if (start.category === 'tool') {
    attributes['tool.name'] = start.name
    attributes['tool.call_id'] = str(profile.tool_call_id)
    attributes['input.value'] = pretty(start.data)
    attributes['output.value'] = pretty(end?.data)

    return attributes
  }

  if (start.category === 'llm') {
    const request = obj(obj(start.data).content)
    const response = obj(end?.data)
    const annotated = obj(profile.annotated_response)
    const usage = { ...obj(response.usage), ...obj(annotated.usage) }
    const messages = Array.isArray(request.messages) ? request.messages : []
    const last = obj(messages.at(-1))
    const choice = obj(Array.isArray(response.choices) ? response.choices[0] : undefined)

    attributes['llm.model_name'] = str(profile.model_name) || str(request.model)
    attributes['llm.token_count.prompt'] = num(usage.prompt_tokens) ?? num(usage.input_tokens)
    attributes['llm.token_count.completion'] = num(usage.completion_tokens) ?? num(usage.output_tokens)
    // Relay's normalized usage has no reasoning field; read the provider's own usage shapes.
    attributes['llm.token_count.reasoning'] =
      num(usage.reasoning_tokens) ??
      num(obj(usage.completion_tokens_details).reasoning_tokens) ??
      num(obj(usage.output_tokens_details).reasoning_tokens)
    // Relay's finish-reason enum is lossy; prefer what the provider actually said.
    attributes['hermes.finish_reason'] =
      str(response.finish_reason) ||
      str(choice.finish_reason) ||
      str(response.stop_reason) ||
      str(annotated.finish_reason)
    attributes['input.value'] = pretty(last.content ?? request.messages)
    attributes['output.value'] = pretty(annotated.message ?? response.content ?? end?.data)

    return attributes
  }

  const metadata = obj(start.metadata)
  attributes['session.source'] = str(metadata['hermes.execution_surface'])

  return attributes
}

/** Bucket a session's Relay log by what the fold reads: scope starts/ends, turn inputs, stream marks. */
function indexEvents(events: RelayEvent[]): {
  starts: Map<string, RelayEvent>
  ends: Map<string, RelayEvent>
  turnInputs: Map<string, string>
  streamMarks: RelayEvent[]
} {
  const starts = new Map<string, RelayEvent>()
  const ends = new Map<string, RelayEvent>()
  const turnInputs = new Map<string, string>()
  const streamMarks: RelayEvent[] = []

  for (const event of events) {
    if (event.kind === 'mark') {
      if (event.name === TURN_INPUT_MARK && event.parent_uuid) {
        turnInputs.set(event.parent_uuid, str(obj(event.data).preview))
      } else if (event.name === FIRST_TOKEN_MARK || event.name === STREAM_MARK) {
        streamMarks.push(event)
      }
    } else if (event.scope_category === 'end') {
      ends.set(event.uuid, event)
    } else {
      starts.set(event.uuid, event)
    }
  }

  return { starts, ends, turnInputs, streamMarks }
}

/** The waterfall label for a scope: the canned names for Hermes's own scopes, the model for a
 *  model call, the raw name otherwise. A session scope with a parent session is a subagent. */
function spanName(start: RelayEvent, uuid: string, turnInputs: Map<string, string>, labels: TraceLabels): string {
  if (start.name === SESSION_SCOPE) {
    return obj(start.metadata)['hermes.parent_session_id'] ? labels.subagent : labels.session
  }

  if (start.name === TURN_SCOPE) {
    return turnInputs.get(uuid) || labels.turn
  }

  if (start.name === LOGICAL_LLM_SCOPE) {
    return labels.llmCall
  }

  if (start.category === 'llm') {
    return str(obj(start.category_profile).model_name) || start.name
  }

  return start.name
}

/** Which session a scope belongs to: its own id if it IS the session scope, else its parent's.
 *  `sessionOf` memoizes across the fold. */
function owningSessionOf(
  starts: Map<string, RelayEvent>,
  sessionOf: Map<string, null | string>,
  uuid: null | string | undefined
): null | string {
  if (!uuid || !starts.has(uuid)) {
    return null
  }

  const cached = sessionOf.get(uuid)

  if (cached !== undefined) {
    return cached
  }

  const start = starts.get(uuid)!
  const own = start.name === SESSION_SCOPE ? str(obj(start.metadata)['hermes.session_id']) || null : null
  const resolved = own ?? owningSessionOf(starts, sessionOf, start.parent_uuid)
  sessionOf.set(uuid, resolved)

  return resolved
}

/** One span per scope start/end pair: an open scope is running and extends to `nowSec`. */
function spansFromScopes(
  starts: Map<string, RelayEvent>,
  ends: Map<string, RelayEvent>,
  turnInputs: Map<string, string>,
  labels: TraceLabels,
  nowSec: number
): TraceSpan[] {
  const spans: TraceSpan[] = []
  const sessionOf = new Map<string, null | string>()

  for (const [uuid, start] of starts) {
    const end = ends.get(uuid)
    const began = relayEventSeconds(start)
    const finished = end ? Math.max(began, relayEventSeconds(end)) : Math.max(began, nowSec)

    spans.push({
      id: uuid,
      parentId: start.parent_uuid && starts.has(start.parent_uuid) ? start.parent_uuid : null,
      name: spanName(start, uuid, turnInputs, labels),
      kind: KIND_BY_CATEGORY[start.category ?? ''] ?? 'CHAIN',
      start: began,
      end: finished,
      duration: finished - began,
      status: spanStatus(end),
      sessionId: owningSessionOf(starts, sessionOf, uuid),
      attributes: spanAttributes(start, end)
    })
  }

  return spans
}

/** Rehang a delegated session's scope under the call that spawned it. In Relay it hangs off the
 *  turn; it belongs to the `delegate_task` call that was open when it started. */
function reparentDelegates(spans: TraceSpan[], starts: Map<string, RelayEvent>): void {
  const delegatesByParent = new Map<null | string, TraceSpan[]>()

  for (const span of spans) {
    if (span.kind === 'TOOL' && span.attributes['tool.name'] === DELEGATE_TOOL) {
      delegatesByParent.set(span.parentId, [...(delegatesByParent.get(span.parentId) ?? []), span])
    }
  }

  const toolByCallId = new Map(
    spans.filter(s => s.kind === 'TOOL' && s.attributes['tool.call_id']).map(s => [s.attributes['tool.call_id'], s])
  )

  for (const span of spans) {
    if (span.kind === 'AGENT' && span.parentId) {
      // Exact when the child names its spawning call; older traces fall back to the delegate
      // call that was open when the child started.
      const spawnedBy = str(obj(starts.get(span.id)?.metadata)[SPAWNED_BY_KEY])

      const spawner =
        (spawnedBy && toolByCallId.get(spawnedBy)) ||
        delegatesByParent.get(span.parentId)?.find(d => d.start <= span.start && span.start <= d.end)

      if (spawner) {
        span.parentId = spawner.id
      }
    }
  }
}

/** Group streamed-output marks onto the model call each belongs to. A managed call's mark names
 *  only its request, so an unnamed mark takes the newest attempt already running under its parent. */
function marksBySpan(spans: TraceSpan[], marks: RelayEvent[]): Map<TraceSpan, RelayEvent[]> {
  const byId = new Map(spans.map(span => [span.id, span]))
  const llmsByParent = new Map<string, TraceSpan[]>()

  for (const span of spans) {
    if (span.kind === 'LLM' && span.parentId) {
      llmsByParent.set(span.parentId, [...(llmsByParent.get(span.parentId) ?? []), span])
    }
  }

  const grouped = new Map<TraceSpan, RelayEvent[]>()

  for (const mark of marks) {
    const at = relayEventSeconds(mark)
    const named = byId.get(str(obj(mark.data).llm_uuid))

    const target =
      named ??
      (llmsByParent.get(mark.parent_uuid ?? '') ?? [])
        .filter(span => span.start <= at)
        .reduce<TraceSpan | undefined>(
          (latest, span) => (!latest || span.start > latest.start ? span : latest),
          undefined
        )

    if (target) {
      grouped.set(target, [...(grouped.get(target) ?? []), mark])
    }
  }

  return grouped
}

/** Derive what the bar and inspector show for one streamed model call: the wait before the first
 *  token, then reasoning/text phases, and the text streamed so far. */
function streamPhases(span: TraceSpan, spanMarks: RelayEvent[]): void {
  const first = spanMarks.find(mark => mark.name === FIRST_TOKEN_MARK)
  const phases: TracePhase[] = []
  const text: Record<string, string> = { reasoning: '', text: '' }

  const push = (kind: TracePhase['kind'], from: number, to: number) => {
    const start = Math.max(span.start, Math.min(from, span.end))
    const end = Math.max(start, Math.min(to, span.end))
    const last = phases.at(-1)

    if (last?.kind === kind) {
      last.end = end
    } else if (end > start) {
      phases.push({ kind, start, end })
    }
  }

  let cursor = first ? relayEventSeconds(first) : span.start
  let kind: TracePhase['kind'] = str(obj(first?.data).kind) === 'reasoning' ? 'reasoning' : 'text'

  if (first) {
    push('wait', span.start, cursor)
    span.attributes['llm.first_token_s'] = cursor - span.start
  }

  for (const mark of spanMarks) {
    if (mark.name !== STREAM_MARK) {
      continue
    }

    const data = obj(mark.data)
    kind = str(data.kind) === 'reasoning' ? 'reasoning' : 'text'
    text[kind] += str(data.text)
    push(kind, cursor, relayEventSeconds(mark))
    cursor = relayEventSeconds(mark)
  }

  push(kind, cursor, span.end)
  span.phases = phases

  if (text.reasoning) {
    span.attributes['llm.reasoning.value'] = text.reasoning
  }

  if (span.status === 'running' && text.text) {
    span.attributes['output.value'] = text.text
  }
}

/**
 * Hang each streamed-output mark on its model call and derive what the bar and inspector show.
 */
function attachStreams(spans: TraceSpan[], marks: RelayEvent[]) {
  if (marks.length === 0) {
    return
  }

  for (const [span, spanMarks] of marksBySpan(spans, marks)) {
    spanMarks.sort((a, b) => relayEventSeconds(a) - relayEventSeconds(b))
    streamPhases(span, spanMarks)
  }
}

/**
 * A session scope stays open for the whole conversation, so "open" is not "working":
 * between turns it ends where its last child ended and is only running while a child is.
 */
function settleOpenSessions(spans: TraceSpan[], starts: Map<string, RelayEvent>, ends: Map<string, RelayEvent>) {
  const children = new Map<string, TraceSpan[]>()

  for (const span of spans) {
    if (span.parentId) {
      children.set(span.parentId, [...(children.get(span.parentId) ?? []), span])
    }
  }

  const settle = (span: TraceSpan): { end: number; running: boolean } => {
    const kids = (children.get(span.id) ?? []).map(settle)
    const open = !ends.has(span.id) && starts.get(span.id)?.name === SESSION_SCOPE

    if (open) {
      span.end = Math.max(span.start, ...kids.map(k => k.end))
      span.duration = span.end - span.start
      span.status = kids.some(k => k.running) ? 'running' : 'unset'
    }

    return { end: span.end, running: span.status === 'running' || kids.some(k => k.running) }
  }

  for (const span of spans) {
    if (span.parentId === null) {
      settle(span)
    }
  }
}

/** The folded trace's time window: the span tree's extremes, or just `nowSec` when empty. */
function traceBounds(spans: TraceSpan[], nowSec: number): { start: number; end: number } {
  if (spans.length === 0) {
    return { start: nowSec, end: nowSec }
  }

  return {
    start: Math.min(...spans.map(s => s.start)),
    end: Math.max(...spans.map(s => s.end))
  }
}

/**
 * Fold one session's Relay event log into the waterfall's span tree. A span is a
 * scope start/end pair (same uuid); an open scope is running and extends to `nowSec`.
 */
export function foldRelayEvents(events: RelayEvent[], labels: TraceLabels, nowSec: number): TraceDoc {
  const { starts, ends, turnInputs, streamMarks } = indexEvents(events)
  const spans = spansFromScopes(starts, ends, turnInputs, labels, nowSec)

  reparentDelegates(spans, starts)
  attachStreams(spans, streamMarks)
  settleOpenSessions(spans, starts, ends)

  const { start, end } = traceBounds(spans, nowSec)
  const root = spans.find(s => s.parentId === null && s.kind === 'AGENT')

  return { rootSessionId: root?.sessionId ?? '', start, end, duration: end - start, spans }
}

/** The root session's turns, oldest first. */
export function traceTurns(doc: TraceDoc): TraceTurnSummary[] {
  const roots = new Set(doc.spans.filter(s => s.parentId === null).map(s => s.id))

  return doc.spans
    .filter(s => s.parentId !== null && roots.has(s.parentId) && s.kind === 'CHAIN')
    .sort((a, b) => a.start - b.start)
    .map((turn, index) => ({
      id: turn.id,
      index,
      label: turn.name,
      start: turn.start,
      end: turn.end,
      duration: turn.duration,
      running: turn.status === 'running'
    }))
}

/** One turn as its own trace: the turn span becomes the root of its subtree. */
export function turnTrace(doc: TraceDoc, turnId: string): TraceDoc {
  const children = new Map<string, TraceSpan[]>()

  for (const span of doc.spans) {
    if (span.parentId) {
      children.set(span.parentId, [...(children.get(span.parentId) ?? []), span])
    }
  }

  const turn = doc.spans.find(s => s.id === turnId)

  if (!turn) {
    return { ...doc, spans: [] }
  }

  const spans: TraceSpan[] = [{ ...turn, parentId: null }]

  for (let i = 0; i < spans.length; i++) {
    spans.push(...(children.get(spans[i]!.id) ?? []))
  }

  return { ...doc, start: turn.start, end: turn.end, duration: turn.duration, spans }
}
