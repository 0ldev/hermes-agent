/**
 * The ConfigTab's section bodies. The tab keeps the gates — each section
 * mounts only when the step's kind offers its fields, in the order the tab
 * has always mounted them — and each body here owns one concern: the scalar
 * knobs, the trigger wiring, the wait condition, the goal, the budgets.
 * Every edit still leaves as a config patch or a graph op.
 */

import {
  CopyButton,
  Field,
  type FieldStatus,
  FieldStatusSlot,
  Input,
  SegmentedControl,
  SidePanelMetaRow,
  SidePanelSection,
  Stepper,
  Textarea
} from '@hermes/plugin-sdk'

import {
  type Join,
  ON_FAIL_OPTIONS,
  type OnFail,
  type StepConfig,
  TRIGGER_KIND_OPTIONS,
  type TriggerKind,
  WAIT_KIND_OPTIONS,
  type WaitKind
} from './scenario'

/** Which fields the step's kind offers, per the schema (`hasField`). */
type HasField = (field: keyof StepConfig) => boolean

/** The status a control wears for this tab's problems (`statusFor`). */
type StatusFor = (field: keyof StepConfig) => FieldStatus | undefined

/** A comma list as typed, kept as the array the runner reads. */
const listOf = (text: string) =>
  text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

const JOIN_OPTIONS: { id: Join; label: string }[] = [
  { id: 'all', label: 'All arrive' },
  { id: 'any', label: 'First arrives' }
]

/** The scalar knobs — what it runs on, what it does on failure, who it asks,
 *  what it may use — one row each, mounted only when the kind offers it. */
export function KnobRows({
  config,
  has,
  inputs,
  isHuman,
  onChange
}: {
  config: StepConfig
  has: HasField
  inputs: number
  isHuman: boolean
  onChange: (patch: Partial<StepConfig>) => void
}) {
  return (
    <>
      {has('model') && (
        <SidePanelMetaRow
          control
          label="Model"
          tip="Overrides the model for this step only. Empty inherits this profile's default."
        >
          <Input
            className="nodrag"
            onChange={e => onChange({ model: e.target.value })}
            placeholder="inherit"
            value={config.model ?? ''}
          />
        </SidePanelMetaRow>
      )}

      {has('onFail') && (
        <SidePanelMetaRow
          control
          label="On failure"
          tip={
            isHuman
              ? 'What the run does if nobody answers in time.'
              : 'What the run does when this step exhausts its retries.'
          }
        >
          <SegmentedControl
            className="nodrag w-full"
            onChange={(v: OnFail) => onChange({ onFail: v })}
            options={ON_FAIL_OPTIONS.map(o => ({ id: o.value, label: o.label }))}
            value={config.onFail ?? 'retry'}
          />
        </SidePanelMetaRow>
      )}

      {has('assignee') && (
        <SidePanelMetaRow control label="Assignee" tip="Who the run parks on. Empty means whoever is watching.">
          <Input
            className="nodrag"
            onChange={e => onChange({ assignee: e.target.value })}
            placeholder="anyone"
            size="sm"
            value={config.assignee ?? ''}
          />
        </SidePanelMetaRow>
      )}

      {has('notify') && (
        <SidePanelMetaRow
          control
          label="Also ask in"
          tip="Chats that get the question too (send_message targets, comma-separated). Answer there with /workflow approve <code>."
        >
          <Input
            className="nodrag"
            onChange={e => onChange({ notify: listOf(e.target.value) })}
            placeholder="telegram, discord:#ops"
            size="sm"
            value={(config.notify ?? []).join(', ')}
          />
        </SidePanelMetaRow>
      )}

      {has('toolsets') && (
        <SidePanelMetaRow
          control
          label="Toolsets"
          tip="Narrow what this step may use (comma-separated toolset names). Empty uses the profile's own set — worth narrowing for a step a webhook or an event can start."
        >
          <Input
            className="nodrag"
            onChange={e => onChange({ toolsets: listOf(e.target.value) })}
            placeholder="profile default"
            size="sm"
            value={(config.toolsets ?? []).join(', ')}
          />
        </SidePanelMetaRow>
      )}

      {has('join') && inputs > 1 && (
        <SidePanelMetaRow
          control
          label="Starts when"
          tip="With several inputs: wait for every one, or start on the first to arrive and ignore the rest."
        >
          <SegmentedControl
            className="nodrag w-full"
            onChange={(v: Join) => onChange({ join: v })}
            options={JOIN_OPTIONS}
            value={config.join ?? 'all'}
          />
        </SidePanelMetaRow>
      )}
    </>
  )
}

/** What begins a run of this workflow — the trigger kind, when it fires, and
 *  a webhook's route and secret once the trigger is one. */
export function TriggerRows({
  config,
  onChange,
  st,
  webhook
}: {
  config: StepConfig
  onChange: (patch: Partial<StepConfig>) => void
  st: StatusFor
  webhook: { route: string; secret: string; url: string }
}) {
  return (
    <>
      <SidePanelMetaRow control label="Starts on" tip="What begins a run of this workflow.">
        <SegmentedControl
          className="nodrag w-full"
          onChange={(v: TriggerKind) => onChange({ on: { spec: config.on?.spec ?? '', type: v } })}
          options={TRIGGER_KIND_OPTIONS.map(o => ({ id: o.value, label: o.label }))}
          value={config.on?.type ?? 'manual'}
        />
      </SidePanelMetaRow>
      {(config.on?.type ?? 'manual') !== 'manual' && (
        <SidePanelMetaRow
          control
          label="When"
          status={st('on')}
          tip={TRIGGER_KIND_OPTIONS.find(o => o.value === (config.on?.type ?? 'manual'))?.hint}
        >
          <Input
            className="nodrag"
            onChange={e => onChange({ on: { spec: e.target.value, type: config.on?.type ?? 'cron' } })}
            placeholder={
              (config.on?.type ?? 'cron') === 'cron'
                ? 'every 2h'
                : (config.on?.type ?? 'cron') === 'webhook'
                  ? 'saved on the gateway as wf:<workflow>'
                  : 'github.pull_request.merged'
            }
            size="sm"
            value={config.on?.spec ?? ''}
          />
        </SidePanelMetaRow>
      )}
      {(config.on?.type ?? 'manual') === 'webhook' && webhook && (
        <>
          <SidePanelMetaRow control label="Route" tip="POST this path on the webhook gateway.">
            <div className="flex items-center gap-1">
              <Input className="nodrag min-w-0 flex-1" readOnly size="sm" value={`/webhooks/${webhook.route}`} />
              <CopyButton appearance="icon" buttonSize="icon-xs" text={`/webhooks/${webhook.route}`} />
            </div>
          </SidePanelMetaRow>
          <SidePanelMetaRow control label="HMAC" tip="Stored under HERMES_HOME/workflows/secrets.json.">
            <div className="flex items-center gap-1">
              <Input className="nodrag min-w-0 flex-1" readOnly size="sm" value={webhook.secret} />
              <CopyButton appearance="icon" buttonSize="icon-xs" text={webhook.secret} />
            </div>
          </SidePanelMetaRow>
        </>
      )}
    </>
  )
}

/** What the world has to do before the run moves on — the wait kind and its spec. */
export function WaitRows({ config, onChange, st }: { config: StepConfig; onChange: (patch: Partial<StepConfig>) => void; st: StatusFor }) {
  return (
    <>
      <SidePanelMetaRow control label="Waiting on" tip="What the world has to do before the run moves on.">
        <SegmentedControl
          className="nodrag w-full"
          onChange={(v: WaitKind) => onChange({ until: { spec: config.until?.spec ?? '', type: v } })}
          options={WAIT_KIND_OPTIONS.map(o => ({ id: o.value, label: o.label }))}
          value={config.until?.type ?? 'timer'}
        />
      </SidePanelMetaRow>
      <SidePanelMetaRow
        control
        label="Condition"
        status={st('until')}
        tip={WAIT_KIND_OPTIONS.find(o => o.value === (config.until?.type ?? 'timer'))?.hint}
      >
        <Input
          className="nodrag"
          onChange={e => onChange({ until: { spec: e.target.value, type: config.until?.type ?? 'timer' } })}
          placeholder={
            (config.until?.type ?? 'timer') === 'timer'
              ? '24h'
              : (config.until?.type ?? 'timer') === 'event'
                ? 'github.pull_request.merged'
                : 'every 5m'
          }
          size="sm"
          value={config.until?.spec ?? ''}
        />
      </SidePanelMetaRow>
    </>
  )
}

/** The goal — the ask a parked human answers, or the brief the subagent gets. */
export function GoalSection({
  config,
  isHuman,
  onChange,
  st
}: {
  config: StepConfig
  isHuman: boolean
  onChange: (patch: Partial<StepConfig>) => void
  st: StatusFor
}) {
  return (
    <SidePanelSection
      label={isHuman ? 'Ask' : 'Goal'}
      title={
        isHuman
          ? "Shown when the run parks here. Your answer is this step's output."
          : "Sent to delegate_task as the subagent's goal."
      }
    >
      <FieldStatusSlot status={st('goal')}>
        <Textarea
          className="nodrag nowheel min-h-24 text-[0.75rem]"
          onChange={e => onChange({ goal: e.target.value })}
          rows={3}
          value={config.goal ?? ''}
        />
      </FieldStatusSlot>
    </SidePanelSection>
  )
}

/** The budgets — tool-call, retry and wall-clock caps on a single take. */
export function BudgetsSection({
  config,
  has,
  isHuman,
  onChange
}: {
  config: StepConfig
  has: HasField
  isHuman: boolean
  onChange: (patch: Partial<StepConfig>) => void
}) {
  return (
    <SidePanelSection label="Budgets">
      {has('maxIterations') && (
        <Field label="Iterations" row tip="Tool-call budget before the subagent must stop.">
          <Stepper
            className="nodrag"
            max={200}
            min={1}
            onChange={v => onChange({ maxIterations: v })}
            step={5}
            value={config.maxIterations ?? 20}
          />
        </Field>
      )}
      {has('maxRetries') && (
        <Field label="Retries" row tip="Takes before the step reports failed.">
          <Stepper
            className="nodrag"
            max={10}
            min={0}
            onChange={v => onChange({ maxRetries: v })}
            value={config.maxRetries ?? 1}
          />
        </Field>
      )}
      {has('timeoutMins') && (
        <Field
          label="Timeout"
          row
          tip={
            isHuman
              ? 'How long the run parks here before nobody answering counts as a failure. ∞ = wait forever.'
              : 'Wall-clock cap on a single take. ∞ = no cap.'
          }
        >
          <Stepper
            className="nodrag"
            max={180}
            min={0}
            onChange={v => onChange({ timeoutMins: v })}
            step={5}
            suffix={(config.timeoutMins ?? 0) > 0 ? 'min' : undefined}
            unboundedAtMin
            value={config.timeoutMins ?? 0}
          />
        </Field>
      )}
    </SidePanelSection>
  )
}
