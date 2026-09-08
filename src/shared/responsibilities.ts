import type { ReasoningEffort } from './reasoning-effort'

export type ResponsibilityKind = 'task' | 'goal' | 'routine'
export type ResponsibilityState = 'proposed' | 'active' | 'paused' | 'blocked' | 'taken_over' | 'completed' | 'cancelled'
export type WorkPhase = 'work' | 'verify' | 'classify' | 'collect'
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
  createdAt: string
}
export interface ResponsibilityAgreement {
  kind: ResponsibilityKind
  title: string
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
  schedule?: string
  source?: RoutineSource
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
  next: { phase: WorkPhase; instruction: string; eventId?: string } | null
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
  action: 'done' | 'continue' | 'ask' | 'ignore' | 'notify' | 'task'
  next?: string
  work: WorkEvidence
  sourceSnapshot?: string
}
export interface ResponsibilityStep {
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
  collection?: { revision: number; trial: boolean; evidence: string }
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
}
export interface ResponsibilitiesApi {
  snapshot(projectId?: string): Promise<ResponsibilitySnapshot>
  pickProjectFolder(): Promise<string | null>
  createProject(name: string, root: string, agentId: string): Promise<ProjectRecord>
  act(id: string, revision: number, action: 'approve' | 'trial' | 'pause' | 'resume' | 'cancel' | 'takeover' | 'handback' | 'recover'): Promise<void>
  answer(id: string, answer: string, approved?: boolean): Promise<void>
  remember(projectId: string, kind: 'fact' | 'preference', text: string, id?: string): Promise<void>
  forget(id: string): Promise<void>
  onChanged(callback: () => void): () => void
}
export const projectConversationId = (id: string): string => `mastermind-project-${id}`
export const isMastermindTask = (id: string): boolean => id === 'mastermind-session' || id.startsWith('mastermind-project-')
