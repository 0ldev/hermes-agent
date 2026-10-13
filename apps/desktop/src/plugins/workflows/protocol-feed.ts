// The activity feed's projection of the same stream — one human-readable line
// per event worth reading, and nothing for the infra chatter the timeline
// already shows as ticks.

import { type EventType, HERMES_EXT, type ProtoEvent } from './protocol'

export interface FeedLine {
  step: string
  /** Colours the line's dot in the feed. The kind IS the visual marker — the
   *  feed used to also carry a per-line glyph, which was redundant with it. */
  kind: 'start' | 'tool' | 'ok' | 'fail' | 'loop' | 'data'
  msg: string
  ext: boolean
  ts: number
}

/** Infra chatter the timeline shows as ticks and the feed leaves out. */
const FEED_HIDDEN: ReadonlySet<EventType> = new Set<EventType>([
  'TokenUsage',
  'SnapshotCaptured',
  'FrameCommitted',
  'NodePending',
  'TodoUpdated',
  'TaskOutput',
  'NodeFinished'
])

/** The ProtoEvent member for one wire type. */
type EventOf<T extends EventType> = Extract<ProtoEvent, { type: T }>

/** The envelope every line shares: when it happened, and whether the canvas
 *  synthesized the event (the timeline shows engine-sourced marks natively). */
const envelope = (e: ProtoEvent): Pick<FeedLine, 'ext' | 'ts'> => ({ ext: HERMES_EXT.has(e.type), ts: e.ts })

/** One line per readable wire type — a row, not a case. */
const LINE_BY_TYPE: { [T in EventType]?: (e: EventOf<T>) => FeedLine } = {
  RunStarted: e => ({ ...envelope(e), step: 'run', kind: 'start', msg: e.payload.scenario }),
  RunFinished: e => ({ ...envelope(e), step: 'run', kind: 'ok', msg: `run ${e.payload.state}` }),
  RunPaused: e => ({ ...envelope(e), step: 'run', kind: 'data', msg: 'paused' }),
  NodeStarted: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: 'start',
    msg: `delegate_task spawned · ${e.payload.input}`
  }),
  AgentTraceEvent: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: 'tool',
    msg: `${e.payload.tool.name}${e.payload.tool.arg ? ` · ${e.payload.tool.arg}` : ''}`
  }),
  AgentTraceSummary: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: e.payload.verdict === 'FAIL' ? 'fail' : 'ok',
    msg: e.payload.summary
  }),
  NodeFailed: e => ({ ...envelope(e), step: e.payload.nodeId, kind: 'fail', msg: e.payload.error }),
  NodeSkipped: e => ({ ...envelope(e), step: e.payload.nodeId, kind: 'data', msg: `skipped · ${e.payload.reason}` }),
  GateEvaluated: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: e.payload.decision === 'pass' ? 'ok' : 'loop',
    msg: e.payload.summary
  }),
  LoopAdvanced: e => ({
    ...envelope(e),
    step: e.payload.loopId,
    kind: 'loop',
    msg: `take ${e.payload.iteration + 1} → ${e.payload.to} · ${e.payload.feedback}`
  }),
  HumanWaiting: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: 'data',
    msg: `waiting on you · ${e.payload.prompt}`
  }),
  HumanResponded: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: e.payload.decision === 'approved' ? 'ok' : 'fail',
    msg: `${e.payload.decision} · ${e.payload.by}`
  }),
  WaitStarted: e => ({
    ...envelope(e),
    step: e.payload.nodeId,
    kind: 'data',
    msg: `waiting on ${e.payload.label}`
  }),
  WaitResolved: e => ({ ...envelope(e), step: e.payload.nodeId, kind: 'ok', msg: e.payload.by }),
  UserAsk: e => ({ ...envelope(e), step: e.payload.nodeId, kind: 'data', msg: e.payload.prompt })
}

/** The line for one wire type, if the feed shows it — the type-safe seam of the keyed dispatch. */
function lineFor<T extends EventType>(e: EventOf<T>): FeedLine | undefined {
  return LINE_BY_TYPE[e.type]?.(e)
}

export function feedLine(e: ProtoEvent): FeedLine | null {
  if (FEED_HIDDEN.has(e.type)) {
    return null
  }

  return lineFor(e) ?? null
}
