// Running a tool from the catalog.
//
// Each op validates its arguments and calls the corresponding primitive in
// graph.ts — the same primitive the inspector and the canvas call — so there is
// no privileged path. If a tool can do it, a person can do it by hand, and vice
// versa. The catalog these dispatch against lives in `graph-tools.ts`.

import {
  addArm,
  addStep,
  connect,
  disconnect,
  type Graph,
  type OpResult,
  removeArm,
  removeStep,
  renameStep,
  setBranch,
  setKind,
  setScenario,
  stepNodes,
  toScenario,
  updateStep,
  validate
} from './graph'
import { fail } from './graph-core'
import { GRAPH_TOOLS } from './graph-tools'
import { DEFAULT_DIR, type FlowDir } from './layout'
import type { Predicate, Scenario, StepConfig, StepKind } from './scenario'

export type ToolArgs = Record<string, unknown>

/** Run control isn't a graph edit, so it can't return a graph. The player is
 *  handed in and these report back in the same shape as everything else. */
export interface RunControl {
  running: boolean
  paused: boolean
  start: () => void
  pause: () => void
  resume: () => void
  reset: () => void
}

/** One op's whole world. `callTool` fills in the defaults so no op has to
 *  defend against a missing args bag or direction. */
interface ToolCtx {
  graph: Graph
  run: RunControl
  args: ToolArgs
  dir: FlowDir
}

const str = (a: ToolArgs, k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)

const opGet = ({ graph }: ToolCtx): OpResult => {
  const s = toScenario(graph)

  return {
    ok: true,
    graph,
    message: `${s.steps.length} steps, ${s.edges.length} wires: ${s.steps.map(x => x.id).join(', ')}.`
  }
}

const opAddStep = ({ graph, args, dir }: ToolCtx): OpResult => {
  const kind = str(args, 'kind')

  if (!kind) {
    return fail(graph, 'graph_add_step needs a kind.')
  }

  return addStep(graph, {
    kind: kind as StepKind,
    title: str(args, 'title'),
    goal: str(args, 'goal'),
    onEdge: str(args, 'on_edge'),
    after: str(args, 'after'),
    before: str(args, 'before'),
    config: args.config as Partial<StepConfig> | undefined,
    dir
  })
}

const opUpdateStep = ({ graph, args }: ToolCtx): OpResult => {
  const step = str(args, 'step')

  if (!step) {
    return fail(graph, 'graph_update_step needs a step.')
  }

  return updateStep(graph, step, (args.patch as Partial<StepConfig>) ?? {})
}

const opRenameStep = ({ graph, args }: ToolCtx): OpResult => {
  const step = str(args, 'step')
  const next = str(args, 'new_id')

  if (!step || !next) {
    return fail(graph, 'graph_rename_step needs a step and a new_id.')
  }

  return renameStep(graph, step, next)
}

const opSetKind = ({ graph, args }: ToolCtx): OpResult => {
  const step = str(args, 'step')
  const kind = str(args, 'kind')

  if (!step || !kind) {
    return fail(graph, 'graph_set_kind needs a step and a kind.')
  }

  return setKind(graph, step, kind as StepKind)
}

const opRemoveStep = ({ graph, args }: ToolCtx): OpResult => {
  const step = str(args, 'step')

  if (!step) {
    return fail(graph, 'graph_remove_step needs a step.')
  }

  return removeStep(graph, step)
}

const opConnect = ({ graph, args }: ToolCtx): OpResult => {
  const source = str(args, 'source')
  const target = str(args, 'target')

  if (!source || !target) {
    return fail(graph, 'graph_connect needs a source and a target.')
  }

  return connect(graph, { source, target, when: args.when as Predicate | undefined })
}

const opDisconnect = ({ graph, args }: ToolCtx): OpResult => {
  const source = str(args, 'source')

  if (!source) {
    return fail(graph, 'graph_disconnect needs a source.')
  }

  return disconnect(graph, source, str(args, 'target'))
}

const opAddArm = ({ graph, args }: ToolCtx): OpResult => {
  const gate = str(args, 'gate')

  if (!gate) {
    return fail(graph, 'graph_add_arm needs a gate.')
  }

  return addArm(graph, gate, args.when as Predicate | undefined, str(args, 'name'))
}

const opRemoveArm = ({ graph, args }: ToolCtx): OpResult => {
  const gate = str(args, 'gate')
  const arm = str(args, 'arm')

  if (!gate || !arm) {
    return fail(graph, 'graph_remove_arm needs a gate and an arm.')
  }

  return removeArm(graph, gate, arm)
}

const opSetBranch = ({ graph, args }: ToolCtx): OpResult => {
  const gate = str(args, 'gate') ?? str(args, 'source')
  const when = args.when as Predicate | undefined
  const label = str(args, 'name')

  if (!gate) {
    return fail(graph, 'graph_set_branch needs a gate.')
  }

  if (!when && label === undefined) {
    return fail(graph, 'graph_set_branch needs a condition or a name.')
  }

  // Addressable either way: by the output's own id, or by somewhere it
  // goes — which is how you'd say it out loud, and all an agent knows
  // before it has read the gate back.
  const target = str(args, 'target')
  const arm = str(args, 'arm') ?? graph.edges.find(e => e.source === gate && e.target === target)?.sourceHandle

  if (!arm) {
    return fail(
      graph,
      target ? `There's no wire from ${gate} to ${target}.` : 'graph_set_branch needs an arm or a target.'
    )
  }

  return setBranch(graph, gate, arm, {
    ...(when ? { when } : {}),
    ...(label !== undefined ? { label } : {})
  })
}

const opSetScenario = ({ graph, args }: ToolCtx): OpResult => {
  const scenario = args.scenario as Scenario | undefined

  if (!scenario) {
    return fail(graph, 'graph_set_scenario needs a scenario.')
  }

  return setScenario(graph, scenario)
}

const opValidate = ({ graph }: ToolCtx): OpResult => {
  const problems = validate(graph)

  return {
    ok: true,
    graph,
    message: problems.length
      ? problems.map(p => `${p.level === 'error' ? '✗' : '!'} ${p.message}`).join(' ')
      : `Looks sound — ${stepNodes(graph).length} steps, nothing unreachable.`
  }
}

const opRunControl = ({ graph, run, args }: ToolCtx): OpResult => {
  switch (str(args, 'action')) {
    case 'start':
      run.start()

      return { ok: true, graph, message: 'Running it.' }

    case 'pause':
      if (!run.running) {
        return fail(graph, 'Nothing is running to pause.')
      }

      run.pause()

      return { ok: true, graph, message: 'Pausing when available.' }

    case 'resume':
      if (!run.paused) {
        return fail(graph, 'Nothing is paused.')
      }

      run.resume()

      return { ok: true, graph, message: 'Resumed.' }

    case 'reset':
      run.reset()

      return { ok: true, graph, message: 'Cleared the run. The scenario is untouched.' }

    default:
      return fail(graph, 'run_control takes start, pause, resume or reset.')
  }
}

/** The ops, keyed by tool name. One entry per catalog entry in `graph-tools.ts`. */
const OPS: Record<string, (ctx: ToolCtx) => OpResult> = {
  graph_add_arm: opAddArm,
  graph_add_step: opAddStep,
  graph_connect: opConnect,
  graph_disconnect: opDisconnect,
  graph_get: opGet,
  graph_remove_arm: opRemoveArm,
  graph_remove_step: opRemoveStep,
  graph_rename_step: opRenameStep,
  graph_set_branch: opSetBranch,
  graph_set_kind: opSetKind,
  graph_set_scenario: opSetScenario,
  graph_update_step: opUpdateStep,
  graph_validate: opValidate,
  run_control: opRunControl
}

/** Run one op. `dir` is the canvas's current orientation — placement is the
 *  one thing an op can't work out from the graph alone, because a rank step
 *  runs down a vertical canvas and across a horizontal one. */
export function callTool(
  graph: Graph,
  run: RunControl,
  name: string,
  args: ToolArgs = {},
  dir: FlowDir = DEFAULT_DIR
): OpResult {
  // hasOwn, not truthiness: `constructor` would answer with one of Object's
  // own and try to run it.
  if (!Object.hasOwn(OPS, name)) {
    return fail(graph, `There's no tool called ${name}. Available: ${GRAPH_TOOLS.map(t => t.name).join(', ')}.`)
  }

  return OPS[name]({ graph, run, args, dir })
}
