// The agents page's strings: roster rows, the expanded transcript, and the
// trace / spawn-tree views of a running session.

export interface AgentsTranslations {
  extendedTranscript: string
  transcriptTruncated: string
  transcriptUnavailable: string
  close: string
  title: string
  subtitle: string
  emptyTitle: string
  emptyDesc: string
  running: string
  failed: string
  done: string
  streaming: string
  files: string
  moreFiles: (count: number) => string
  moreAgents: (count: number) => string
  queued: string
  waitingActivity: string
  steer: string
  steerPlaceholder: string
  steerQueued: string
  stopRequested: string
  requestRejected: string
  delegation: (index: number) => string
  workers: (count: number) => string
  workersActive: (count: number) => string
  agentsCount: (count: number) => string
  activeCount: (count: number) => string
  failedCount: (count: number) => string
  toolsCount: (count: number) => string
  filesCount: (count: number) => string
  updatedAgo: (age: string) => string
  ageNow: string
  ageSeconds: (seconds: number) => string
  ageMinutes: (minutes: number) => string
  ageHours: (hours: number) => string
  ageDays: (days: number) => string
  durationSeconds: (seconds: string) => string
  durationMinutes: (minutes: number, seconds: number) => string
  tokens: (value: number | string) => string
  viewTrace: string
  viewTree: string
  traceTitle: string
  traceSubtitle: (spans: number, duration: string) => string
  traceNoSession: string
  traceLoading: string
  traceEmptyTitle: string
  traceEmptyDesc: string
  traceOffTitle: string
  traceOffDesc: string
  traceTruncated: string
  allTurns: string
  allTurnsShort: string
  turnAria: (index: number) => string
  turnTip: (index: number, label: string) => string
  showLabels: string
  hideLabels: string
  inspectHint: string
  spanSession: string
  spanSubagent: string
  spanTurn: string
  spanLlmCall: string
  inspector: {
    kind: string
    status: string
    started: string
    duration: string
    firstToken: string
    model: string
    tokensIn: string
    tokensOut: string
    reasoning: string
    tokensTotal: string
    finish: string
    tool: string
    source: string
    session: string
    input: string
    thinking: string
    output: string
  }
}
