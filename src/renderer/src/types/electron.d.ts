import type {
  WorkfloTask,
  CreateTaskDTO,
  UpdateTaskDTO,
  FileAttachment,
  Agent,
  CreateAgentDTO,
  UpdateAgentDTO,
  McpServer,
  CreateMcpServerDTO,
  UpdateMcpServerDTO,
  TaskSource,
  CreateTaskSourceDTO,
  UpdateTaskSourceDTO,
  SyncResult,
  PluginMeta,
  ConfigFieldSchema,
  ConfigFieldOption,
  PluginAction,
  ActionResult
} from './index'

export interface AgentSessionStartResult {
  sessionId: string
}

export interface AgentSessionSuccessResult {
  success: boolean
}

export interface AgentOutputEvent {
  sessionId: string
  taskId?: string
  type: 'message' | 'error' | 'status'
  data: unknown
}

export interface AgentStatusEvent {
  sessionId: string
  agentId: string
  taskId: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
}

export interface AgentApprovalRequest {
  sessionId: string
  action: string
  description: string
}

export interface McpTestResult {
  status: 'connected' | 'failed'
  error?: string
  toolCount?: number
  tools?: { name: string; description: string }[]
}

export interface GhCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export interface GitHubRepo {
  name: string
  fullName: string
  defaultBranch: string
  cloneUrl: string
  description: string
  isPrivate: boolean
}

export interface WorktreeProgressEvent {
  taskId: string
  repo: string
  step: string
  done: boolean
  error?: string
}

interface ElectronAPI {
  db: {
    getTasks: () => Promise<WorkfloTask[]>
    getTask: (id: string) => Promise<WorkfloTask | undefined>
    createTask: (data: CreateTaskDTO) => Promise<WorkfloTask>
    updateTask: (id: string, data: UpdateTaskDTO) => Promise<WorkfloTask | undefined>
    deleteTask: (id: string) => Promise<boolean>
  }
  mcpServers: {
    getAll: () => Promise<McpServer[]>
    get: (id: string) => Promise<McpServer | undefined>
    create: (data: CreateMcpServerDTO) => Promise<McpServer>
    update: (id: string, data: UpdateMcpServerDTO) => Promise<McpServer | undefined>
    delete: (id: string) => Promise<boolean>
    testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }) => Promise<McpTestResult>
  }
  agents: {
    getAll: () => Promise<Agent[]>
    get: (id: string) => Promise<Agent | undefined>
    create: (data: CreateAgentDTO) => Promise<Agent>
    update: (id: string, data: UpdateAgentDTO) => Promise<Agent | undefined>
    delete: (id: string) => Promise<boolean>
  }
  agentSession: {
    start: (agentId: string, taskId: string, workspaceDir?: string) => Promise<AgentSessionStartResult>
    abort: (sessionId: string) => Promise<AgentSessionSuccessResult>
    stop: (sessionId: string) => Promise<AgentSessionSuccessResult>
    send: (sessionId: string, message: string) => Promise<AgentSessionSuccessResult>
    approve: (sessionId: string, approved: boolean, message?: string) => Promise<AgentSessionSuccessResult>
  }
  agentConfig: {
    getProviders: (serverUrl?: string) => Promise<{ providers: any[]; default: Record<string, string> } | null>
  }
  attachments: {
    pick: () => Promise<string[]>
    save: (taskId: string, filePath: string) => Promise<FileAttachment>
    remove: (taskId: string, attachmentId: string) => Promise<void>
    open: (taskId: string, attachmentId: string) => Promise<void>
  }
  shell: {
    openPath: (filePath: string) => Promise<void>
    showItemInFolder: (filePath: string) => Promise<void>
    readTextFile: (filePath: string) => Promise<{ content: string; size: number } | null>
  }
  notifications: {
    show: (title: string, body: string) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    getAll: () => Promise<Record<string, string>>
  }
  github: {
    checkCli: () => Promise<GhCliStatus>
    startAuth: () => Promise<void>
    fetchOrgs: () => Promise<string[]>
    fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
  }
  worktree: {
    setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string) => Promise<string>
    cleanup: (taskId: string, repos: { fullName: string }[], org: string) => Promise<void>
  }
  taskSources: {
    getAll: () => Promise<TaskSource[]>
    get: (id: string) => Promise<TaskSource | undefined>
    create: (data: CreateTaskSourceDTO) => Promise<TaskSource>
    update: (id: string, data: UpdateTaskSourceDTO) => Promise<TaskSource | undefined>
    delete: (id: string) => Promise<boolean>
    sync: (sourceId: string) => Promise<SyncResult>
    exportUpdate: (taskId: string, fields: Record<string, unknown>) => Promise<void>
  }
  plugins: {
    list: () => Promise<PluginMeta[]>
    getConfigSchema: (pluginId: string) => Promise<ConfigFieldSchema[]>
    resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string) => Promise<ConfigFieldOption[]>
    getActions: (pluginId: string, config: Record<string, unknown>) => Promise<PluginAction[]>
    executeAction: (actionId: string, taskId: string, sourceId: string, input?: string) => Promise<ActionResult>
  }
  onOverdueCheck: (callback: () => void) => () => void
  onAgentOutput: (callback: (event: AgentOutputEvent) => void) => () => void
  onAgentStatus: (callback: (event: AgentStatusEvent) => void) => () => void
  onAgentApproval: (callback: (event: AgentApprovalRequest) => void) => () => void
  onWorktreeProgress: (callback: (event: WorktreeProgressEvent) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
