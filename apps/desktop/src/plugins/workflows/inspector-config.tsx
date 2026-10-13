/**
 * The step as authored. Which knobs appear is the schema's answer (`hasField`),
 * not the kind's — a kind that grows a field grows the control for free.
 *
 * Every edit leaves as a config patch or a graph op; the tab never reaches into
 * node data itself.
 */

import {
  Callout,
  Field,
  FieldStatusSlot,
  SegmentedControl,
  SidePanelMeta,
  SidePanelMetaRow,
  SidePanelSection,
  Stepper,
  Switch,
  Textarea,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import { $currentId, $webhooks } from './documents'
import { type Graph, isLoop, type OpResult, type Problem, setKind } from './graph'
import { BranchEditor } from './inspector-branches'
import { BudgetsSection, GoalSection, KnobRows, TriggerRows, WaitRows } from './inspector-config-sections'
import type { StepDef } from './scenario'
import { hasField, STEP_KINDS, type StepConfig } from './scenario'
import { statusFor } from './validation'

function PayloadEditor({ onChange, value }: { onChange: (v?: Record<string, unknown>) => void; value?: object }) {
  const [draft, setDraft] = useState(() => (value ? JSON.stringify(value, null, 2) : ''))
  const [bad, setBad] = useState(false)

  const commit = (text: string) => {
    setDraft(text)

    if (!text.trim()) {
      setBad(false)
      onChange(undefined)

      return
    }

    try {
      const parsed: unknown = JSON.parse(text)
      const ok = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      setBad(!ok)

      if (ok) {
        onChange(parsed as Record<string, unknown>)
      }
    } catch {
      setBad(true)
    }
  }

  return (
    <FieldStatusSlot status={bad ? { level: 'error', message: 'Not a JSON object yet.' } : undefined}>
      <Textarea
        className="nodrag nowheel min-h-20 font-mono text-[0.6875rem]"
        onChange={e => commit(e.target.value)}
        placeholder='{"pull_request": {"number": 12}}'
        rows={3}
        value={draft}
      />
    </FieldStatusSlot>
  )
}

export function ConfigTab({
  config,
  def,
  graph,
  onChange,
  onOp,
  problems,
  strict
}: {
  config: StepConfig
  def: StepDef
  graph: Graph
  onChange: (patch: Partial<StepConfig>) => void
  onOp: (op: OpResult) => OpResult
  problems: Problem[]
  strict: boolean
}) {
  const has = (f: keyof StepConfig) => hasField(def.kind, f)
  const isHuman = def.kind === 'human'
  const budgets = (['maxIterations', 'maxRetries', 'timeoutMins'] as const).some(has)
  const st = (field: keyof StepConfig) => statusFor(problems, strict, field)
  // What's wrong with the step's wiring rather than with anything you could
  // type here — it has no control to sit under, so it keeps the banner.
  const unplaced = problems.filter(p => !p.field)
  const webhook = useValue($webhooks)[useValue($currentId) ?? '']
  const inputs = graph.edges.filter(e => e.target === def.id && !isLoop(e)).length

  return (
    <div className="flex flex-col gap-4 text-sm">
      {unplaced.map((p, i) => (
        <Callout
          icon={p.level === 'error' ? 'error' : 'warning'}
          key={i}
          title={p.message}
          tone={p.level === 'error' ? 'var(--destructive, #f87171)' : '#fbbf24'}
        />
      ))}

      <SidePanelMeta>
        <SidePanelMetaRow
          control
          label="Type"
          tip="What runs this step. Changing it keeps the name, the instruction and the wiring."
        >
          <SegmentedControl
            className="nodrag w-full"
            onChange={k => onOp(setKind(graph, def.id, k))}
            options={STEP_KINDS.map(k => ({ id: k.kind, label: k.title }))}
            value={def.kind}
          />
        </SidePanelMetaRow>

        <KnobRows config={config} has={has} inputs={inputs} isHuman={isHuman} onChange={onChange} />

        {has('on') && <TriggerRows config={config} onChange={onChange} st={st} webhook={webhook} />}

        {has('until') && <WaitRows config={config} onChange={onChange} st={st} />}

        {has('maxLoops') && (
          <Field label="Max takes" row tip="How many takes the gate may send back before giving up.">
            <Stepper
              className="nodrag"
              max={20}
              min={1}
              onChange={v => onChange({ maxLoops: v })}
              value={config.maxLoops ?? 0}
            />
          </Field>
        )}

        {has('blind') && (
          <label className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-(--ui-text-secondary)">
            <Switch
              aria-label="Blind to upstream output"
              checked={!!config.blind}
              className="nodrag"
              onCheckedChange={v => onChange({ blind: v })}
              size="xs"
            />
            Blind to upstream output
          </label>
        )}
      </SidePanelMeta>

      {has('goal') && <GoalSection config={config} isHuman={isHuman} onChange={onChange} st={st} />}

      {budgets && <BudgetsSection config={config} has={has} isHuman={isHuman} onChange={onChange} />}

      {has('pinPayload') && (config.on?.type ?? 'manual') !== 'manual' && (
        <SidePanelSection
          label="Test payload"
          title="Used when you press Play, so this workflow can be tried without a real delivery."
        >
          <PayloadEditor onChange={v => onChange({ pinPayload: v })} value={config.pinPayload} />
        </SidePanelSection>
      )}

      {has('arms') && <BranchEditor gateId={def.id} graph={graph} onOp={onOp} problems={problems} strict={strict} />}
    </div>
  )
}
