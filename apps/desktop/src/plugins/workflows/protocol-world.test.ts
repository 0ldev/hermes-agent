import { describe, expect, it } from 'vitest'

import { type ProtoEvent, type RunShape, type World } from './protocol'
import { reduceEvents } from './protocol-world'

const SHAPE: RunShape = {
  steps: ['draft', 'gate', 'ship'],
  edges: [
    { id: 'draft-gate', source: 'draft', target: 'gate' },
    { id: 'gate-ship', source: 'gate', target: 'ship' },
    { id: 'rework', source: 'gate', target: 'draft', loop: true }
  ]
}

// A looping run: the draft step finishes, the gate rejects it, the loop-back edge
// lights until the take-2 restart clears it.
const LOOPING: ProtoEvent[] = [
  { runId: 'r', seq: 0, ts: 0, type: 'RunStarted', payload: { scenario: 'release' } },
  { runId: 'r', seq: 1, ts: 1, type: 'NodePending', payload: { nodeId: 'draft', iteration: 0 } },
  { runId: 'r', seq: 2, ts: 2, type: 'NodeStarted', payload: { nodeId: 'draft', iteration: 0, input: 'write the release notes', maxIters: 20 } },
  { runId: 'r', seq: 3, ts: 3, type: 'AgentTraceEvent', payload: { nodeId: 'draft', iteration: 0, tool: { name: 'web_search', arg: 'changelog' } } },
  { runId: 'r', seq: 4, ts: 4, type: 'TodoUpdated', payload: { nodeId: 'draft', iteration: 0, todos: [{ id: 't1', content: 'notes', status: 'completed' }] } },
  { runId: 'r', seq: 5, ts: 5, type: 'TokenUsage', payload: { nodeId: 'draft', iteration: 0, tokens: 500 } },
  { runId: 'r', seq: 6, ts: 6, type: 'TaskOutput', payload: { nodeId: 'draft', iteration: 0, output: { pr_url: 'https://github.com/x/y/pull/1' } } },
  { runId: 'r', seq: 7, ts: 7, type: 'AgentTraceSummary', payload: { nodeId: 'draft', iteration: 0, summary: 'notes drafted', verdict: 'PASS' } },
  { runId: 'r', seq: 8, ts: 8, type: 'NodeFinished', payload: { nodeId: 'draft', iteration: 0 } },
  { runId: 'r', seq: 9, ts: 9, type: 'GateEvaluated', payload: { nodeId: 'gate', iteration: 0, inputs: [{ nodeId: 'draft', verdict: 'PASS' }], decision: 'fail', route: 'rework', summary: 'add the screenshot' } },
  { runId: 'r', seq: 10, ts: 10, type: 'LoopAdvanced', payload: { loopId: 'rework', iteration: 1, to: 'draft', feedback: 'add screenshot' } },
  { runId: 'r', seq: 11, ts: 11, type: 'NodePending', payload: { nodeId: 'draft', iteration: 1 } },
  { runId: 'r', seq: 12, ts: 12, type: 'NodeStarted', payload: { nodeId: 'draft', iteration: 1, input: 'revise', maxIters: 20, loop: true } },
  { runId: 'r', seq: 13, ts: 13, type: 'RunFinished', payload: { state: 'succeeded' } }
]

describe('reduceEvents', () => {
  it('folds a looping run into the world the canvas renders', () => {
    expect(reduceEvents(LOOPING, SHAPE)).toEqual({
      phase: 'done',
      take: 2,
      clockTs: 13,
      steps: {
        draft: {
          status: 'looping',
          currentTool: null,
          toolCalls: [],
          todos: [],
          iterations: 0,
          maxIters: 20,
          tokens: 0,
          take: 2,
          startedAt: 12,
          durationMs: null,
          verdict: null,
          input: 'revise',
          summary: null,
          output: null,
          skipped: null
        },
        gate: {
          status: 'looping',
          currentTool: null,
          toolCalls: [],
          todos: [],
          iterations: 0,
          maxIters: 0,
          tokens: 0,
          take: 0,
          startedAt: null,
          durationMs: null,
          verdict: 'FAIL',
          input: 'draft PASS',
          summary: 'add the screenshot',
          output: null,
          skipped: null
        },
        ship: {
          status: 'idle',
          currentTool: null,
          toolCalls: [],
          todos: [],
          iterations: 0,
          maxIters: 0,
          tokens: 0,
          take: 0,
          startedAt: null,
          durationMs: null,
          verdict: null,
          input: null,
          summary: null,
          output: null,
          skipped: null
        }
      },
      edges: {
        'draft-gate': 'done',
        'gate-ship': 'idle',
        rework: 'idle'
      }
    } satisfies World)
  })

  it('replays a prefix: at the checkpoint the loop edge is lit and the gate holds the run', () => {
    // Events 0..10: through the LoopAdvanced bump, before the take-2 restart.
    const world = reduceEvents(LOOPING, SHAPE, 11)

    expect(world.phase).toBe('running')
    expect(world.take).toBe(2)
    expect(world.clockTs).toBe(10)
    expect(world.steps.draft).toMatchObject({ status: 'done', verdict: 'PASS', take: 1, tokens: 500, durationMs: 6 })
    expect(world.edges).toEqual({ 'draft-gate': 'done', 'gate-ship': 'idle', rework: 'loop' })

    // Just the RunStarted envelope: everything idle, take 1.
    expect(reduceEvents(LOOPING, SHAPE, 1)).toMatchObject({ phase: 'running', take: 1, clockTs: 0 })
  })

  it('parks on a person and a timer, and settles a failed or skipped step', () => {
    const world = reduceEvents(
      [
        { runId: 'r', seq: 0, ts: 0, type: 'RunStarted', payload: { scenario: 'checks' } },
        { runId: 'r', seq: 1, ts: 1, type: 'NodeStarted', payload: { nodeId: 'ask', iteration: 0, input: 'approve?', maxIters: 1 } },
        { runId: 'r', seq: 2, ts: 2, type: 'HumanWaiting', payload: { nodeId: 'ask', iteration: 0, prompt: 'ok to ship?', who: 'brooklyn', onFail: 'halt' } },
        { runId: 'r', seq: 3, ts: 3, type: 'HumanResponded', payload: { nodeId: 'ask', iteration: 0, decision: 'approved', by: 'brooklyn' } },
        { runId: 'r', seq: 4, ts: 4, type: 'NodeStarted', payload: { nodeId: 'timer', iteration: 0, input: 'wait', maxIters: 1 } },
        { runId: 'r', seq: 5, ts: 5, type: 'WaitStarted', payload: { nodeId: 'timer', iteration: 0, until: '2026-01-01', label: 'cooldown' } },
        { runId: 'r', seq: 6, ts: 6, type: 'WaitResolved', payload: { nodeId: 'timer', iteration: 0, by: 'timer' } },
        { runId: 'r', seq: 7, ts: 7, type: 'NodeStarted', payload: { nodeId: 'boom', iteration: 0, input: 'explode', maxIters: 1 } },
        { runId: 'r', seq: 8, ts: 8, type: 'NodeFailed', payload: { nodeId: 'boom', iteration: 0, error: 'kaput' } },
        { runId: 'r', seq: 9, ts: 9, type: 'NodePending', payload: { nodeId: 'skipme', iteration: 0 } },
        { runId: 'r', seq: 10, ts: 10, type: 'NodeSkipped', payload: { nodeId: 'skipme', iteration: 0, reason: 'already done upstream' } }
      ],
      { steps: ['ask', 'timer', 'boom', 'skipme'], edges: [] }
    )

    expect(world.steps.ask).toMatchObject({ status: 'done', verdict: 'PASS', summary: 'approved · brooklyn', durationMs: 2, startedAt: 1 })
    expect(world.steps.timer).toMatchObject({ status: 'done', summary: 'timer', input: '2026-01-01', durationMs: 2 })
    expect(world.steps.boom).toMatchObject({ status: 'failed', summary: 'kaput', durationMs: 1 })
    // Held over, not re-run — it keeps the queued status and take of the run.
    expect(world.steps.skipme).toMatchObject({ status: 'queued', take: 1, skipped: 'already done upstream' })
  })
})
