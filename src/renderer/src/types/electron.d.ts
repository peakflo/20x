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
  Skill,
  CreateSkillDTO,
  UpdateSkillDTO,
  TaskSource,
  CreateTaskSourceDTO,
  UpdateTaskSourceDTO,
  SyncResult,
  PluginMeta,
  ConfigFieldSchema,
  ConfigFieldOption,
  PluginAction,
  ActionResult,
  SourceUser,
  ReassignResult
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

export interface SkillSyncResult {
  created: string[]
  updated: string[]
  unchanged: string[]
}

export interface McpTestResult {
  status: 'connected' | 'failed'
  error?: string
  errorDetail?: string
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

export interface GitHubCollaborator {
  login: string
  avatar_url: string
  type: string
}

export interface WorktreeProgressEvent {
  taskId: string
  repo: string
  step: string
  done: boolean
  error?: string
}

export interface DepsStatus {
  gh: boolean
  opencode: boolean
  opencodeBinary: boolean
}

interface ElectronAPI {
  db: {
    getTasks: () => Promise<WorkfloTask[]>
    getTask: (id: string) => Promise<WorkfloTask | undefined>
    createTask: (data: CreateTaskDTO) => Promise<WorkfloTask>
    updateTask: (id: string, data: UpdateTaskDTO) => Promise<WorkfloTask | undefined>
    deleteTask: (id: string) => Promise<boolean>
  }
  tasks: {
    getWorkspaceDir: (taskId: string) => Promise<string>
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
    start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => Promise<AgentSessionStartResult>
    resume: (agentId: string, taskId: string, ocSessionId: string) => Promise<AgentSessionStartResult>
    abort: (sessionId: string) => Promise<AgentSessionSuccessResult>
    stop: (sessionId: string) => Promise<AgentSessionSuccessResult>
    send: (sessionId: string, message: string, taskId?: string, agentId?: string) => Promise<AgentSessionSuccessResult & { newSessionId?: string }>
    approve: (sessionId: string, approved: boolean, message?: string) => Promise<AgentSessionSuccessResult>
    syncSkills: (sessionId: string) => Promise<SkillSyncResult>
    syncSkillsForTask: (taskId: string) => Promise<SkillSyncResult>
    learnFromSession: (sessionId: string, message: string) => Promise<SkillSyncResult>
  }
  agentConfig: {
    getProviders: (serverUrl?: string) => Promise<{ providers: any[]; default: Record<string, string> } | null>
  }
  attachments: {
    pick: () => Promise<string[]>
    save: (taskId: string, filePath: string) => Promise<FileAttachment>
    remove: (taskId: string, attachmentId: string) => Promise<void>
    open: (taskId: string, attachmentId: string) => Promise<void>
    download: (taskId: string, attachmentId: string) => Promise<void>
  }
  shell: {
    openPath: (filePath: string) => Promise<void>
    showItemInFolder: (filePath: string) => Promise<void>
    readTextFile: (filePath: string) => Promise<{ content: string; size: number } | null>
    openExternal: (url: string) => Promise<void>
  }
  oauth: {
    startFlow: (provider: string, config: Record<string, unknown>) => Promise<string>
    exchangeCode: (provider: string, code: string, state: string, sourceId: string) => Promise<void>
    startLocalhostFlow: (provider: string, config: Record<string, unknown>, sourceId: string) => Promise<void>
    getValidToken: (sourceId: string) => Promise<string | null>
    revokeToken: (sourceId: string) => Promise<void>
  }
  notifications: {
    show: (title: string, body: string) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    getAll: () => Promise<Record<string, string>>
  }
  env: {
    get: (key: string) => Promise<string | null>
  }
  github: {
    checkCli: () => Promise<GhCliStatus>
    startAuth: () => Promise<void>
    fetchOrgs: () => Promise<string[]>
    fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
    fetchUserRepos: () => Promise<GitHubRepo[]>
    fetchCollaborators: (owner: string, repo: string) => Promise<GitHubCollaborator[]>
  }
  worktree: {
    setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string) => Promise<string>
    cleanup: (taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean) => Promise<void>
  }
  taskSources: {
    getAll: () => Promise<TaskSource[]>
    get: (id: string) => Promise<TaskSource | undefined>
    create: (data: CreateTaskSourceDTO) => Promise<TaskSource>
    update: (id: string, data: UpdateTaskSourceDTO) => Promise<TaskSource | undefined>
    delete: (id: string) => Promise<boolean>
    sync: (sourceId: string) => Promise<SyncResult>
    exportUpdate: (taskId: string, fields: Record<string, unknown>) => Promise<void>
    getUsers: (sourceId: string) => Promise<SourceUser[]>
    reassign: (taskId: string, userIds: string[], assigneeDisplay: string) => Promise<ReassignResult>
  }
  skills: {
    getAll: () => Promise<Skill[]>
    get: (id: string) => Promise<Skill | undefined>
    create: (data: CreateSkillDTO) => Promise<Skill>
    update: (id: string, data: UpdateSkillDTO) => Promise<Skill | undefined>
    delete: (id: string) => Promise<boolean>
  }
  deps: {
    check: () => Promise<DepsStatus>
    setOpencodePath: (dirPath: string) => Promise<{ success: boolean; error?: string }>
  }
  plugins: {
    list: () => Promise<PluginMeta[]>
    getConfigSchema: (pluginId: string) => Promise<ConfigFieldSchema[]>
    getDocumentation: (pluginId: string) => Promise<string | null>
    resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string) => Promise<ConfigFieldOption[]>
    getActions: (pluginId: string, config: Record<string, unknown>) => Promise<PluginAction[]>
    executeAction: (actionId: string, taskId: string, sourceId: string, input?: string) => Promise<ActionResult>
  }
  app: {
    getLoginItemSettings: () => Promise<{ openAtLogin: boolean; openAsHidden: boolean }>
    setLoginItemSettings: (openAtLogin: boolean) => Promise<{ openAtLogin: boolean; openAsHidden: boolean }>
    getNotificationPermission: () => Promise<'granted' | 'denied'>
    requestNotificationPermission: () => Promise<'granted' | 'denied'>
    getMinimizeToTray: () => Promise<boolean>
    setMinimizeToTray: (enabled: boolean) => Promise<boolean>
    sendTestNotification: () => Promise<void>
    openNotificationSettings: () => Promise<void>
  }
  onOverdueCheck: (callback: () => void) => () => void
  onAgentOutput: (callback: (event: AgentOutputEvent) => void) => () => void
  onAgentStatus: (callback: (event: AgentStatusEvent) => void) => () => void
  onAgentApproval: (callback: (event: AgentApprovalRequest) => void) => () => void
  onAgentIncompatibleSession: (callback: (event: { taskId: string; agentId: string; error: string }) => void) => () => void
  onTaskUpdated: (callback: (event: { taskId: string; updates: Partial<WorkfloTask> }) => void) => () => void
  onTaskNavigate: (callback: (taskId: string) => void) => () => void
  reportSelectedTask: (taskId: string | null) => void
  onTaskCreated: (callback: (event: { task: WorkfloTask }) => void) => () => void
  onWorktreeProgress: (callback: (event: WorktreeProgressEvent) => void) => () => void
  onGithubDeviceCode: (callback: (code: string) => void) => () => void
  onOAuthCallback: (callback: (event: { code: string; state: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
