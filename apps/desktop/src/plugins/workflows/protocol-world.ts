// Folding the event stream into the world the canvas renders.
//
// Replaying a prefix is the whole time-travel mechanism — there is no separate
// historical store, and no state here that isn't derivable from the events in
// `protocol.ts` plus the shape of what's being run.

import {
  type Checkpoint,
  type EdgeState,
  type EventType,
  freshRuntime,
  isBrokenReply,
  type NodeRef,
  type ProtoEvent,
  type RunPhase,
  type RunShape,
  type StepRuntime,
  type StepStatus,
  type World
} from './protocol'

function initialRuntime(shape: RunShape): Record<string, StepRuntime> {
  return Object.fromEntries(shape.steps.map(id => [id, freshRuntime()]))
}

function initialEdgeState(shape: RunShape): Record<string, EdgeState> {
  return Object.fromEntries(shape.edges.map(e => [e.id, 'idle' as EdgeState]))
}

/** All checkpoints present in a stream (the scrubber's stops). */
export function checkpointsOf(events: ProtoEvent[]): Checkpoint[] {
  const out: Checkpoint[] = []
  events.forEach((e, at) => {
    if (e.type === 'FrameCommitted') {
      out.push({ no: e.payload.frameNo, label: e.payload.label, at })
    }
  })

  return out
}

/** The ProtoEvent member for one wire type. */
type EventOf<T extends EventType> = Extract<ProtoEvent, { type: T }>

/**
 * The mutable world one event applies to. A handler mutates it in place —
 * replaying a prefix refolds from scratch, so the fold itself stays
 * throwaway state.
 */
interface Fold {
  steps: Record<string, StepRuntime>
  phase: RunPhase
  take: number
  // A loop-back edge is lit from the moment the run advances to the next take
  // until its target actually restarts. The engine reports the bump; the edge
  // is ours.
  loopTarget: string | null
}

/** The runtime of the step an event addresses — undefined for run-level events. */
function stepOf(e: ProtoEvent, fold: Fold): StepRuntime | undefined {
  const nodeId = (e.payload as Partial<NodeRef>).nodeId

  return nodeId ? fold.steps[nodeId] : undefined
}

/** Elapsed from the step's own start, or null if it never started. */
function elapsedSince(rt: StepRuntime, ts: number): number | null {
  return rt.startedAt != null ? ts - rt.startedAt : null
}

function onNodePending(e: EventOf<'NodePending'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    Object.assign(rt, freshRuntime(), {
      status: 'queued' as StepStatus,
      take: e.payload.iteration + 1
    })
  }
}

function onNodeStarted(e: EventOf<'NodeStarted'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.status = e.payload.loop ? 'looping' : 'running'
    rt.startedAt = e.ts
    rt.durationMs = null
    rt.input = e.payload.input
    rt.maxIters = e.payload.maxIters
    rt.take = e.payload.iteration + 1
    rt.skipped = null
  }

  if (fold.loopTarget === e.payload.nodeId) {
    fold.loopTarget = null
  }

  fold.take = Math.max(fold.take, e.payload.iteration + 1)
}

function onAgentTraceEvent(e: EventOf<'AgentTraceEvent'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.currentTool = e.payload.tool
    rt.toolCalls = [...rt.toolCalls, e.payload.tool]
    rt.iterations += 1
  }
}

function onTokenUsage(e: EventOf<'TokenUsage'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.tokens += e.payload.tokens
  }
}

function onTodoUpdated(e: EventOf<'TodoUpdated'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.todos = e.payload.todos.map(t => ({ ...t }))
  }
}

function onAgentTraceSummary(e: EventOf<'AgentTraceSummary'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.summary = e.payload.summary
    rt.verdict = e.payload.verdict ?? null
  }
}

function onTaskOutput(e: EventOf<'TaskOutput'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.output = e.payload.output
  }
}

function onNodeFinished(e: EventOf<'NodeFinished'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    // The wire says "finished" whether the agent approved or rejected —
    // a FAIL is a value in its structured output, not a task error. The
    // canvas is what turns a rejecting validator red.
    //
    // A transport error returned as the reply (auth missing, HTTP 4xx)
    // is not a verdict — treat it as the step breaking.
    rt.status = rt.verdict === 'FAIL' || isBrokenReply(rt.summary) ? 'failed' : 'done'
    rt.currentTool = null
    rt.durationMs = elapsedSince(rt, e.ts)
  }
}

function onNodeFailed(e: EventOf<'NodeFailed'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.status = 'failed'
    rt.currentTool = null
    rt.summary = e.payload.error
    rt.durationMs = elapsedSince(rt, e.ts)
  }
}

function onNodeSkipped(e: EventOf<'NodeSkipped'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  // Held over, not re-run — it keeps the take number and telemetry of
  // the take that satisfied it.
  if (rt) {
    rt.skipped = e.payload.reason
  }
}

function onGateEvaluated(e: EventOf<'GateEvaluated'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.verdict = e.payload.decision === 'pass' ? 'PASS' : 'FAIL'
    rt.summary = e.payload.summary
    rt.input = e.payload.inputs.map(v => `${v.nodeId} ${v.verdict ?? '—'}`).join(' · ')
    rt.status = e.payload.decision === 'pass' ? 'done' : 'looping'
    rt.currentTool = null
    rt.durationMs = elapsedSince(rt, e.ts)
  }
}

function onHumanWaiting(e: EventOf<'HumanWaiting'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  // The run parks. startedAt keeps ticking — elapsed-while-blocked is
  // the one number a waiting card owes you.
  if (rt) {
    rt.status = 'waiting'
    rt.summary = e.payload.prompt

    if (rt.startedAt == null) {
      rt.startedAt = e.ts
    }
  }
}

function onWaitStarted(e: EventOf<'WaitStarted'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.status = 'waiting'
    rt.input = e.payload.until
    rt.summary = e.payload.label
    rt.take = e.payload.iteration + 1

    if (rt.startedAt == null) {
      rt.startedAt = e.ts
    }
  }
}

function onWaitResolved(e: EventOf<'WaitResolved'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    // A wait has no opinion, so it reports no verdict — it either came
    // back or the run is still sitting on it.
    rt.status = 'done'
    rt.summary = e.payload.by
    rt.durationMs = elapsedSince(rt, e.ts)
  }
}

function onHumanResponded(e: EventOf<'HumanResponded'>, fold: Fold): void {
  const rt = stepOf(e, fold)

  if (rt) {
    rt.verdict = e.payload.decision === 'approved' ? 'PASS' : 'FAIL'
    rt.status = e.payload.decision === 'approved' ? 'done' : 'failed'
    rt.summary = `${e.payload.decision} · ${e.payload.by}`
    rt.durationMs = elapsedSince(rt, e.ts)
  }
}

function onLoopAdvanced(e: EventOf<'LoopAdvanced'>, fold: Fold): void {
  fold.loopTarget = e.payload.to
  fold.take = e.payload.iteration + 1
}

/** One named fold per readable wire event — a row, not a case. */
type Handler<T extends EventType> = (e: EventOf<T>, fold: Fold) => void
type Handlers = { [T in EventType]?: Handler<T> }

// Events with no row (RunPaused, FrameCommitted, SnapshotCaptured, UserAsk)
// leave the world untouched.
const HANDLERS: Handlers = {
  RunStarted: (e, fold) => {
    fold.phase = 'running'
    fold.take = 1
  },
  RunFinished: (e, fold) => {
    fold.phase = 'done'
  },
  NodePending: onNodePending,
  NodeStarted: onNodeStarted,
  AgentTraceEvent: onAgentTraceEvent,
  TokenUsage: onTokenUsage,
  TodoUpdated: onTodoUpdated,
  AgentTraceSummary: onAgentTraceSummary,
  TaskOutput: onTaskOutput,
  NodeFinished: onNodeFinished,
  NodeFailed: onNodeFailed,
  NodeSkipped: onNodeSkipped,
  GateEvaluated: onGateEvaluated,
  HumanWaiting: onHumanWaiting,
  WaitStarted: onWaitStarted,
  WaitResolved: onWaitResolved,
  HumanResponded: onHumanResponded,
  LoopAdvanced: onLoopAdvanced
}

/** Look up and apply the fold for `e`'s type — the type-safe seam of the keyed dispatch. */
function applyEvent<T extends EventType>(handlers: Handlers, e: EventOf<T>, fold: Fold): void {
  handlers[e.type]?.(e, fold)
}

/** Edge lights follow from step state: a link is live while its target is queued
 *  behind a finished source, and settled once the target has run. */
function edgeState(
  def: RunShape['edges'][number],
  steps: Record<string, StepRuntime>,
  loopTarget: string | null
): EdgeState {
  if (def.loop) {
    return loopTarget === def.target ? 'loop' : 'idle'
  }

  const src = steps[def.source]
  const tgt = steps[def.target]
  const srcSettled = src.status === 'done' || src.status === 'failed'

  if (tgt.status === 'queued') {
    return srcSettled ? 'active' : 'idle'
  }

  return tgt.status !== 'idle' ? 'done' : 'idle'
}

/**
 * Fold `count` events into the world the canvas renders. Replaying a prefix is
 * the whole time-travel mechanism — there is no separate historical store.
 */
export function reduceEvents(events: ProtoEvent[], shape: RunShape, count = events.length): World {
  const fold: Fold = { steps: initialRuntime(shape), phase: 'idle', take: 0, loopTarget: null }
  const edges = initialEdgeState(shape)
  let clockTs: number | null = null

  for (let i = 0; i < Math.min(count, events.length); i++) {
    const e = events[i]
    clockTs = e.ts
    applyEvent(HANDLERS, e, fold)
  }

  for (const def of shape.edges) {
    edges[def.id] = edgeState(def, fold.steps, fold.loopTarget)
  }

  return { phase: fold.phase, take: fold.take, steps: fold.steps, edges, clockTs }
}
