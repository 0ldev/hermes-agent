import { describe, expect, it } from 'vitest'

import { type EventType, type ProtoEvent } from './protocol'
import { feedLine } from './protocol-feed'

type EventOf<T extends EventType> = Extract<ProtoEvent, { type: T }>

const ev = <T extends EventType>(type: T, payload: EventOf<T>['payload'], ts = 0): EventOf<T> =>
  ({ runId: 'r', seq: 0, ts, type, payload }) as EventOf<T>

describe('feedLine', () => {
  it('projects the events worth reading, ext-flagged when the canvas synthesized them', () => {
    const lines = [
      feedLine(ev('RunStarted', { scenario: 'release' }, 1)),
      feedLine(ev('RunFinished', { state: 'succeeded' }, 2)),
      feedLine(ev('RunPaused', {}, 3)),
      feedLine(ev('NodeStarted', { nodeId: 'draft', iteration: 0, input: 'write', maxIters: 1 }, 4)),
      feedLine(ev('AgentTraceEvent', { nodeId: 'draft', iteration: 0, tool: { name: 'web_search', arg: 'changelog' } }, 5)),
      feedLine(ev('AgentTraceEvent', { nodeId: 'draft', iteration: 0, tool: { name: 'read_file', arg: '' } }, 6)),
      feedLine(ev('AgentTraceSummary', { nodeId: 'draft', iteration: 0, summary: 'done', verdict: 'PASS' }, 7)),
      feedLine(ev('AgentTraceSummary', { nodeId: 'draft', iteration: 0, summary: 'rejected', verdict: 'FAIL' }, 8)),
      feedLine(ev('AgentTraceSummary', { nodeId: 'draft', iteration: 0, summary: 'unclear' }, 9)),
      feedLine(ev('NodeFailed', { nodeId: 'boom', iteration: 0, error: 'kaput' }, 10)),
      feedLine(ev('NodeSkipped', { nodeId: 'hold', iteration: 0, reason: 'held' }, 11)),
      feedLine(ev('GateEvaluated', { nodeId: 'gate', iteration: 0, inputs: [], decision: 'pass', route: 'go', summary: 'ship it' }, 12)),
      feedLine(ev('GateEvaluated', { nodeId: 'gate', iteration: 0, inputs: [], decision: 'fail', route: 'rework', summary: 'add tests' }, 13)),
      feedLine(ev('LoopAdvanced', { loopId: 'rework', iteration: 1, to: 'draft', feedback: 'tighten' }, 14)),
      feedLine(ev('HumanWaiting', { nodeId: 'ask', iteration: 0, prompt: 'ok to ship?', who: 'brooklyn', onFail: 'halt' }, 15)),
      feedLine(ev('HumanResponded', { nodeId: 'ask', iteration: 0, decision: 'approved', by: 'brooklyn' }, 16)),
      feedLine(ev('HumanResponded', { nodeId: 'ask', iteration: 0, decision: 'denied', by: 'brooklyn' }, 17)),
      feedLine(ev('WaitStarted', { nodeId: 'timer', iteration: 0, until: '2026-01-01', label: 'cooldown' }, 18)),
      feedLine(ev('WaitResolved', { nodeId: 'timer', iteration: 0, by: 'timer' }, 19)),
      feedLine(ev('UserAsk', { nodeId: 'ask', iteration: 0, prompt: 'why?' }, 20))
    ]

    expect(lines).toEqual([
      { ext: false, ts: 1, step: 'run', kind: 'start', msg: 'release' },
      { ext: false, ts: 2, step: 'run', kind: 'ok', msg: 'run succeeded' },
      { ext: true, ts: 3, step: 'run', kind: 'data', msg: 'paused' },
      { ext: false, ts: 4, step: 'draft', kind: 'start', msg: 'delegate_task spawned · write' },
      { ext: false, ts: 5, step: 'draft', kind: 'tool', msg: 'web_search · changelog' },
      { ext: false, ts: 6, step: 'draft', kind: 'tool', msg: 'read_file' },
      { ext: false, ts: 7, step: 'draft', kind: 'ok', msg: 'done' },
      { ext: false, ts: 8, step: 'draft', kind: 'fail', msg: 'rejected' },
      { ext: false, ts: 9, step: 'draft', kind: 'ok', msg: 'unclear' },
      { ext: false, ts: 10, step: 'boom', kind: 'fail', msg: 'kaput' },
      { ext: true, ts: 11, step: 'hold', kind: 'data', msg: 'skipped · held' },
      { ext: true, ts: 12, step: 'gate', kind: 'ok', msg: 'ship it' },
      { ext: true, ts: 13, step: 'gate', kind: 'loop', msg: 'add tests' },
      { ext: true, ts: 14, step: 'rework', kind: 'loop', msg: 'take 2 → draft · tighten' },
      { ext: true, ts: 15, step: 'ask', kind: 'data', msg: 'waiting on you · ok to ship?' },
      { ext: true, ts: 16, step: 'ask', kind: 'ok', msg: 'approved · brooklyn' },
      { ext: true, ts: 17, step: 'ask', kind: 'fail', msg: 'denied · brooklyn' },
      { ext: true, ts: 18, step: 'timer', kind: 'data', msg: 'waiting on cooldown' },
      { ext: true, ts: 19, step: 'timer', kind: 'ok', msg: 'timer' },
      { ext: true, ts: 20, step: 'ask', kind: 'data', msg: 'why?' }
    ])
  })

  it('leaves out the infra chatter the timeline already shows as ticks', () => {
    const hidden = [
      feedLine(ev('TokenUsage', { nodeId: 'draft', iteration: 0, tokens: 5 })),
      feedLine(ev('SnapshotCaptured', { frameNo: 1 })),
      feedLine(ev('FrameCommitted', { frameNo: 1, label: 'v1' })),
      feedLine(ev('NodePending', { nodeId: 'draft', iteration: 0 })),
      feedLine(ev('TodoUpdated', { nodeId: 'draft', iteration: 0, todos: [] })),
      feedLine(ev('TaskOutput', { nodeId: 'draft', iteration: 0, output: {} })),
      feedLine(ev('NodeFinished', { nodeId: 'draft', iteration: 0 }))
    ]

    expect(hidden).toEqual([null, null, null, null, null, null, null])
  })
})
