// Pinning the op layer's outward behaviour — the messages, results and problem
// lists the composer transcript and the inspector render — so the dispatch
// table and the per-check helpers behind it can be reshaped without changing a
// word of it.

import { describe, expect, it } from 'vitest'

import { addStep, fromScenario, validate } from './graph'
import { callTool, type RunControl } from './graph-dispatch'
import type { Scenario } from './scenario'

// Kick feeds Build feeds the Gate; Publish hangs off the Gate. Stray and
// Loose feed only each other, so nothing that starts a run can reach them.
// Enough shape to trip one of every check: a cron trigger with no schedule,
// an empty goal, a one-output gate with no default arm, and steps nothing
// reaches. Positions on every step keep the node order the authored order, so
// the problem list pins the check order too.
const scenario: Scenario = {
  version: 1,
  steps: [
    {
      id: 'kick',
      kind: 'trigger',
      position: { x: 0, y: 0 },
      config: { title: 'Kick', on: { type: 'cron', spec: '' } }
    },
    { id: 'build', kind: 'agent', position: { x: 1, y: 0 }, config: { title: 'Build' } },
    { id: 'gate', kind: 'gate', position: { x: 2, y: 0 }, config: { title: 'Gate' } },
    { id: 'publish', kind: 'agent', position: { x: 3, y: 0 }, config: { title: 'Publish' } },
    { id: 'stray', kind: 'agent', position: { x: 4, y: 0 }, config: { title: 'Stray' } },
    { id: 'loose', kind: 'agent', position: { x: 5, y: 0 }, config: { title: 'Loose' } }
  ],
  edges: [
    { id: 'kick->build', source: 'kick', target: 'build' },
    { id: 'build->gate', source: 'build', target: 'gate' },
    { id: 'gate->publish', source: 'gate', target: 'publish' },
    { id: 'stray->loose', source: 'stray', target: 'loose' },
    { id: 'loose->stray', source: 'loose', target: 'stray' }
  ]
}

const graph = () => fromScenario(scenario)

const makeRun = (): RunControl & { calls: string[] } => {
  const calls: string[] = []

  return {
    calls,
    running: false,
    paused: false,
    start: () => calls.push('start'),
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
    reset: () => calls.push('reset')
  }
}

describe('a tool call dispatched against the graph', () => {
  it('reads the scenario back as a line', () => {
    const g = graph()

    expect(callTool(g, makeRun(), 'graph_get')).toEqual({
      ok: true,
      graph: g,
      message: '6 steps, 5 wires: kick, build, gate, publish, stray, loose.'
    })
  })

  it('adds a wired step and reports where it landed', () => {
    const result = callTool(graph(), makeRun(), 'graph_add_step', { kind: 'gate', title: 'Judge', after: 'build' })

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Added Judge after build.')
    expect(result.focus).toBe('judge')
    expect(result.graph.edges.map(e => e.id)).toContain('build->judge')
  })

  it('refuses a call missing its key argument, leaving the graph alone', () => {
    const g = graph()

    expect(callTool(g, makeRun(), 'graph_add_step', { title: 'Judge' })).toEqual({
      ok: false,
      graph: g,
      message: 'graph_add_step needs a kind.'
    })
  })

  it('refuses an unknown kind rather than minting one', () => {
    const result = callTool(graph(), makeRun(), 'graph_add_step', { kind: 'alien' })

    expect(result.ok).toBe(false)
    expect(result.message).toBe('There\'s no "alien" kind — use agent, gate, human, wait or trigger.')
  })

  it('addresses a gate output by where it routes', () => {
    const result = callTool(graph(), makeRun(), 'graph_set_branch', {
      gate: 'gate',
      target: 'publish',
      when: { mode: 'always' }
    })

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Updated gate\'s "anything else" output.')
  })

  it('needs a condition or a name to change a branch', () => {
    const g = graph()

    expect(callTool(g, makeRun(), 'graph_set_branch', { gate: 'gate' })).toEqual({
      ok: false,
      graph: g,
      message: 'graph_set_branch needs a condition or a name.'
    })
  })

  it('drives the run only through the player it was handed', () => {
    const run = makeRun()

    expect(callTool(graph(), run, 'run_control', { action: 'start' }).message).toBe('Running it.')
    expect(callTool(graph(), run, 'run_control', { action: 'pause' }).message).toBe('Nothing is running to pause.')
    expect(callTool(graph(), run, 'run_control', { action: 'bogus' }).message).toBe(
      'run_control takes start, pause, resume or reset.'
    )
    expect(run.calls).toEqual(['start'])
  })

  it('says what went wrong with the scenario, in order', () => {
    const result = callTool(graph(), makeRun(), 'graph_validate')

    expect(result.message).toBe(
      "! kick doesn't say what starts the run. ! build has no goal. " +
        "! gate is a gate with one output — it isn't branching. " +
        '! gate has no default arm, so some verdicts route nowhere. ' +
        '! publish has no goal. ' +
        "✗ stray can't be reached from a start. ! stray has no goal. " +
        "✗ loose can't be reached from a start. ! loose has no goal."
    )
  })

  it('reports a sound scenario', () => {
    const sound: Scenario = {
      version: 1,
      steps: [
        {
          id: 'kick',
          kind: 'trigger',
          position: { x: 0, y: 0 },
          config: { title: 'Kick', on: { type: 'manual', spec: '' } }
        },
        { id: 'build', kind: 'agent', position: { x: 1, y: 0 }, config: { title: 'Build', goal: 'Do it.' } }
      ],
      edges: [{ id: 'kick->build', source: 'kick', target: 'build' }]
    }

    expect(callTool(fromScenario(sound), makeRun(), 'graph_validate').message).toBe(
      'Looks sound — 2 steps, nothing unreachable.'
    )
  })

  it('refuses anything outside the catalog, including inherited keys', () => {
    const available =
      'Available: graph_get, graph_add_step, graph_update_step, graph_rename_step, graph_set_kind, ' +
      'graph_remove_step, graph_connect, graph_disconnect, graph_add_arm, graph_remove_arm, ' +
      'graph_set_branch, graph_set_scenario, graph_validate, run_control.'

    expect(callTool(graph(), makeRun(), 'graph_party').message).toBe(`There's no tool called graph_party. ${available}`)
    // A dispatch table keyed by tool name would otherwise answer `constructor`
    // with one of Object's own — the switch this table replaced didn't.
    expect(callTool(graph(), makeRun(), 'constructor').message).toBe(`There's no tool called constructor. ${available}`)
  })
})

describe('adding a step', () => {
  it('wires it in after another and says so', () => {
    const result = addStep(graph(), { kind: 'agent', title: 'Review', after: 'build' })

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Added Review after build.')
    expect(result.focus).toBe('review')
    expect(result.edit).toBe('+ step review')
    expect(result.graph.edges.map(e => e.id)).toContain('build->review')
  })

  it('splices into a wire, taking its place in the middle', () => {
    const result = addStep(graph(), { kind: 'agent', title: 'Lint', onEdge: 'build->gate' })
    const ids = result.graph.edges.map(e => e.id)

    expect(result.message).toBe('Added Lint between build and gate.')
    expect(ids).not.toContain('build->gate')
    expect(ids).toContain('build->lint')
    expect(ids).toContain('lint->gate')
  })

  it('wires by both ends at once', () => {
    const result = addStep(graph(), { kind: 'agent', title: 'Gatekeep', after: 'kick', before: 'build' })

    expect(result.message).toBe('Added Gatekeep after kick and before build.')
  })

  it("refuses a step that isn't there, leaving the graph alone", () => {
    const g = graph()

    expect(addStep(g, { kind: 'agent', title: 'X', after: 'nope' })).toEqual({
      ok: false,
      graph: g,
      message: 'There\'s no step called "nope".'
    })
  })
})

describe('checking the scenario', () => {
  it('lists every problem, in the order the steps and checks run', () => {
    expect(validate(graph())).toEqual([
      {
        field: 'on',
        hint: 'Say how often.',
        level: 'warning',
        message: "kick doesn't say what starts the run.",
        step: 'kick'
      },
      {
        field: 'goal',
        hint: 'Say what this step should do.',
        level: 'warning',
        message: 'build has no goal.',
        step: 'build'
      },
      {
        field: 'arms',
        hint: 'One output isn\u2019t a branch — add another.',
        level: 'warning',
        message: "gate is a gate with one output — it isn't branching.",
        step: 'gate'
      },
      {
        field: 'arms',
        hint: 'No default rule, so some verdicts route nowhere.',
        level: 'warning',
        message: 'gate has no default arm, so some verdicts route nowhere.',
        step: 'gate'
      },
      {
        field: 'goal',
        hint: 'Say what this step should do.',
        level: 'warning',
        message: 'publish has no goal.',
        step: 'publish'
      },
      { level: 'error', message: "stray can't be reached from a start.", step: 'stray' },
      {
        field: 'goal',
        hint: 'Say what this step should do.',
        level: 'warning',
        message: 'stray has no goal.',
        step: 'stray'
      },
      { level: 'error', message: "loose can't be reached from a start.", step: 'loose' },
      {
        field: 'goal',
        hint: 'Say what this step should do.',
        level: 'warning',
        message: 'loose has no goal.',
        step: 'loose'
      }
    ])
  })

  it('calls out a scenario that can never start', () => {
    const cycle: Scenario = {
      version: 1,
      steps: [
        { id: 'a', kind: 'agent', position: { x: 0, y: 0 }, config: { title: 'A' } },
        { id: 'b', kind: 'agent', position: { x: 0, y: 0 }, config: { title: 'B' } }
      ],
      edges: [
        { id: 'a->b', source: 'a', target: 'b' },
        { id: 'b->a', source: 'b', target: 'a' }
      ]
    }

    expect(validate(fromScenario(cycle))).toEqual([
      { level: 'error', message: 'Nothing starts the run — every step has an input.' },
      { field: 'goal', hint: 'Say what this step should do.', level: 'warning', message: 'a has no goal.', step: 'a' },
      { field: 'goal', hint: 'Say what this step should do.', level: 'warning', message: 'b has no goal.', step: 'b' }
    ])
  })

  it('answers an empty canvas with one warning, not a wall', () => {
    expect(validate({ nodes: [], edges: [] })).toEqual([{ level: 'warning', message: 'The scenario is empty.' }])
  })
})
