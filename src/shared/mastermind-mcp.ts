export const MASTERMIND_MCP_PORT = 20621
export const MASTERMIND_MCP_URL = `http://127.0.0.1:${MASTERMIND_MCP_PORT}/mcp`
export const MASTERMIND_MCP_SETTING = 'mastermind_mcp_enabled'
export const MASTERMIND_MCP_SKILL_VERSION = '1'

export type MastermindMcpClient = 'codex' | 'pi' | 'claude'
export type MastermindMcpRequestState = 'queued' | 'delivering' | 'processing' | 'answered' | 'action_required' | 'failed'

export interface MastermindMcpRequest {
  id: string
  projectId: string
  workspacePath: string
  message: string
  fingerprint: string
  humanInputId: string
  state: MastermindMcpRequestState
  createdAt: string
  startedAt?: string
  finishedAt?: string
  sessionId?: string
  reply?: string
  responsibilityId?: string
  error?: string
}

export interface MastermindMcpReply {
  request_id: string
  workspace: { id: string; name: string; root: string }
  status: 'processing' | 'answered' | 'action_required' | 'failed'
  reply?: string
  responsibility_id?: string
  responsibility_state?: string
  skill_version: string
}

export type MastermindMcpSkillState = 'not_installed' | 'current' | 'outdated' | 'modified' | 'client_unavailable'
export interface MastermindMcpClientStatus {
  client: MastermindMcpClient
  available: boolean
  configured: boolean
  skillState: MastermindMcpSkillState
  installedVersion?: string
  skillPath: string
}
export interface MastermindMcpStatus {
  enabled: boolean
  running: boolean
  url: string
  error?: string
  skillVersion: string
  clients: Record<MastermindMcpClient, MastermindMcpClientStatus>
}
export interface MastermindMcpInstallResult {
  status: MastermindMcpStatus
  changedPaths: string[]
  backupPaths: string[]
  restartRequired: boolean
}

export interface MastermindMcpApi {
  status(): Promise<MastermindMcpStatus>
  setEnabled(enabled: boolean): Promise<MastermindMcpStatus>
  install(client: MastermindMcpClient): Promise<MastermindMcpInstallResult>
  checkSkillVersions(): Promise<MastermindMcpStatus>
}
