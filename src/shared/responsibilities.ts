import type { ReasoningEffort } from './reasoning-effort'

export const decisionQuestionLimit = 600
export const decisionQuestionGuidance = `Questions appear in a narrow Mastermind Decisions card. Ask ONE thing the engineer can answer, in plain language, using three short lines:
Question: the decision or missing information?
Why: one short sentence explaining what is blocked.
Reply: Yes / No, two or three short choices, or the specific value needed.
Keep the entire question under ${decisionQuestionLimit} characters (aim for 60 words). In report_responsibility with action=ask, put only these lines in next; keep detailed findings in summary and evidence, available through Open task. Name the action and any material consequence clearly. Omit internal tool names, argument names, UUIDs and coordination instructions unless the engineer specifically needs an exact identifier to choose. Never ask the engineer to call an internal tool or repair coordinator wiring. Explain an app limitation plainly; ask only for an actual human decision or missing information, and do not ask again for permission already granted.\n`

export type ResponsibilityKind = 'task' | 'goal' | 'routine'
export type ResponsibilityState = 'proposed' | 'active' | 'paused' | 'blocked' | 'taken_over' | 'completed' | 'cancelled'
export type WorkPhase = 'work' | 'verify' | 'classify' | 'collect' | 'coordinate' | 'setup'
export interface ExecutionAccess {
  permissionMode: 'ask' | 'allow'
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
}
export interface FactoryDefinition {
  id: string
  projectId: string
  name: string
  diagram: string
  guide: string
  provenance: string
  createdAt: string
  updatedAt: string
}
export interface FactoryProposal {
  id: string
  definition: FactoryDefinition
  operation: 'save' | 'delete'
  replacesDigest: string | null
}
export interface FactoryAgent {
  id: string
  name: string
  backend?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  configDigest: string
  access?: ExecutionAccess
}
export interface CommandSource {
  command: string
  args: string[]
  description: string
}
export interface McpSourceRead {
  kind: 'mcp'
  serverId: string
  tool: string
  arguments: Record<string, unknown>
  description: string
  /** JSON pointers into the decoded tool result. */
  pagination?: { cursorArgument: string; nextCursorPath: string; itemsPath: string; maxPages: number }
  /** Explicit stable fields to compare; omit to retain the complete result. */
  select?: string[]
  /** Bound by the app, never accepted as model-supplied authority. */
  connectionVersion?: string
  toolVersion?: string
  serverName?: string
}
export type SourceRead = McpSourceRead | (CommandSource & { kind: 'command' })
export type RoutineSource = CommandSource | {
  kind: 'collection'
  description: string
  reads: SourceRead[]
  /** Optional bounded reasoning over collected evidence before comparison. */
  reasoning?: string
}
export const isSourceCollection = (source: RoutineSource): source is Extract<RoutineSource, { kind: 'collection' }> => 'kind' in source && source.kind === 'collection'
export interface ProjectRecord {
  id: string
  name: string
  root: string
  agentId: string
  /** Default for new work; independent of the Mastermind conversation agent. */
  workAgentId?: string
  workAgentInputId?: string
  createdAt: string
}
export interface ResponsibilityAgreement {
  kind: ResponsibilityKind
  title: string
  /** Display only; the full objective and scope still define the work. */
  summary?: string
  objective: string
  scope: string
  finish: string
  stop: string
  mode: 'read' | 'edit'
  agentId: string
  backend?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  priority: 'low' | 'medium' | 'high' | 'critical'
  maxSteps: number
  deadline: string
  basedOn?: string
  factoryId?: string
  /** Server-owned snapshots, never model-supplied authority. */
  factory?: FactoryDefinition
  factoryAgents?: FactoryAgent[]
  allowedAgentIds?: string[]
  schedule?: string
  source?: RoutineSource
  stopOnSuccess?: boolean
  /** Captured from agent settings by 20x, never accepted from a model. */
  access?: ExecutionAccess
}
export interface ResponsibilityRecord {
  id: string
  projectId: string
  agreement: ResponsibilityAgreement
  revision: number
  approvedRevision: number | null
  humanInputId: string
  state: ResponsibilityState
  /** Deleted proposals remain as history for any source-trial tasks. */
  deletedAt?: string
  steps: number
  noProgress: number
  nextAt: string | null
  cursor: string | null
  executionWorkspace?: string
  workspace: string | null
  trial: { output: string; at: string; revision: number; evidence?: string } | null
  lastCollectedAt?: string
  /** Factory selected for the current Routine event only. */
  eventFactory?: FactoryDefinition
  factoryStartStep?: number
  routineSetup?: { proposalId?: string }
  /** Preparation evidence; unlike basedOn, this does not require the setup task to finish first. */
  preparedFrom?: string
  next: { phase: WorkPhase; instruction: string; eventId?: string; agentId?: string; predecessorTaskIds?: string[]; completeRoutine?: boolean } | null
  createdAt: string
  updatedAt: string
}
export interface WorkEvidence {
  checkout: string
  revision: string
  fingerprint: string
}
export interface WorkReport {
  summary: string
  evidence: string[]
  action: 'done' | 'continue' | 'ask' | 'ignore' | 'notify' | 'task' | 'complete'
  next?: string
  work: WorkEvidence
  sourceSnapshot?: string
  agentId?: string
  factoryId?: string
  predecessorTaskIds?: string[]
  factory?: FactoryDefinition
}
export interface ResponsibilityStep {
  inputRevision?: number
  id: string
  responsibilityId: string
  taskId: string
  phase: WorkPhase
  instruction: string
  state: 'reserved' | 'running' | 'settled' | 'releasing' | 'unknown' | 'held'
  sessionId: string | null
  report: WorkReport | null
  expectedWork: WorkEvidence | null
  settledAt: string | null
  createdAt: string
  completeRoutine?: boolean
  collection?: { revision: number; trial: boolean; evidence: string }
  agent?: FactoryAgent
  factory?: FactoryDefinition
  predecessorTaskIds?: string[]
}
export interface ResponsibilityNotice {
  id: string
  projectId: string
  responsibilityId: string | null
  stepId: string | null
  kind: 'result' | 'question' | 'recovery' | 'permission'
  title: string
  body: string
  state: 'pending' | 'delivering' | 'answered' | 'read' | 'expired'
  answer: string | null
  deliveryError?: string
  callback?: boolean
  questions?: Array<{ question: string; header: string }>
  recipient: { sessionId: string; requestId: string; responseType: 'permission' | 'question' } | null
  createdAt: string
}
export interface ProjectMemory {
  id: string
  projectId: string
  kind: 'fact' | 'preference'
  text: string
  provenance: string
  updatedAt: string
}
export interface ResponsibilitySnapshot {
  projects: ProjectRecord[]
  responsibilities: ResponsibilityRecord[]
  notices: ResponsibilityNotice[]
  memory: ProjectMemory[]
  steps: ResponsibilityStep[]
  followups?: Record<string, { enabled: boolean; reviewing: boolean; pending: number; error?: string }>
  factories?: FactoryDefinition[]
  factoryProposals?: FactoryProposal[]
}
export interface ResponsibilitiesApi {
  setProactive(projectId: string, enabled: boolean): Promise<void>
  retryFollowups(projectId: string): Promise<void>
  snapshot(projectId?: string): Promise<ResponsibilitySnapshot>
  pickProjectFolder(): Promise<string | null>
  createProject(name: string, root: string, agentId: string): Promise<ProjectRecord>
  act(id: string, revision: number, action: 'approve' | 'trial' | 'pause' | 'resume' | 'cancel' | 'takeover' | 'handback' | 'recover'): Promise<void>
  answer(id: string, answer: string, approved?: boolean): Promise<void>
  remember(projectId: string, kind: 'fact' | 'preference', text: string, id?: string): Promise<void>
  forget(id: string): Promise<void>
  decideFactory(proposalId: string, approve: boolean): Promise<void>
  onChanged(callback: () => void): () => void
}
export const projectConversationId = (id: string): string => `mastermind-project-${id}`
export const isMastermindTask = (id: string): boolean => id === 'mastermind-session' || id.startsWith('mastermind-project-')
