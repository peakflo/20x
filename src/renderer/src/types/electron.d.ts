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
  Secret,
  CreateSecretDTO,
  UpdateSecretDTO,
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
  ReassignResult,
  MarketplaceSource,
  InstalledPlugin,
  DiscoverablePlugin,
  MarketplaceCatalog,
  PluginResources,
  HeartbeatLog
} from './index'

export interface AgentSessionStartResult {
  sessionId: string
}

export interface AgentSessionSuccessResult {
  success: boolean
}

export interface AgentMessageAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
}

export interface AgentOutputEvent {
  sessionId: string
  taskId?: string
  type: 'message' | 'error' | 'status'
  data: unknown
}

export interface AgentOutputBatchEvent {
  sessionId: string
  taskId: string
  messages: Array<{ id: string; role: string; content: string; partType?: string; tool?: unknown; update?: boolean; taskProgress?: unknown }>
}

export interface AgentStatusEvent {
  sessionId: string
  agentId: string
  taskId: string
  status: import('@/stores/agent-store').SessionStatus
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

export interface HeartbeatStatusResult {
  enabled: boolean
  intervalMinutes: number | null
  lastCheckAt: string | null
  nextCheckAt: string | null
  hasHeartbeatFile: boolean
}

export interface HeartbeatAlertEvent {
  taskId: string
  title: string
  summary: string
}

export interface WorktreeProgressEvent {
  taskId: string
  repo: string
  step: string
  done: boolean
  error?: string
}

export interface ToolStatus {
  installed: boolean
  version: string | null
}

export interface DepsStatus {
  nodejs: ToolStatus
  npm: ToolStatus
  pnpm: ToolStatus
  git: ToolStatus
  gh: ToolStatus
  glab: ToolStatus
  claudeCode: ToolStatus
  opencode: ToolStatus
  codex: ToolStatus
}

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

interface ElectronAPI {
  db: {
    getTasks: () => Promise<WorkfloTask[]>
    getTask: (id: string) => Promise<WorkfloTask | undefined>
    createTask: (data: CreateTaskDTO) => Promise<WorkfloTask>
    updateTask: (id: string, data: UpdateTaskDTO) => Promise<WorkfloTask | undefined>
    deleteTask: (id: string) => Promise<boolean>
    getSubtasks: (parentId: string) => Promise<WorkfloTask[]>
    reorderSubtasks: (parentId: string, orderedIds: string[]) => Promise<boolean>
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
    startOAuthFlow: (mcpServerId: string) => Promise<{ needsManualClientId?: boolean }>
    getOAuthStatus: (mcpServerId: string) => Promise<{ connected: boolean; expiresAt?: string }>
    revokeOAuthToken: (mcpServerId: string) => Promise<void>
    probeForAuth: (serverUrl: string) => Promise<{ requiresAuth: boolean }>
    submitManualClientId: (mcpServerId: string, clientId: string) => Promise<{ needsManualClientId?: boolean }>
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
    send: (sessionId: string, message: string, taskId?: string, agentId?: string, attachments?: AgentMessageAttachment[]) => Promise<AgentSessionSuccessResult & { newSessionId?: string }>
    approve: (sessionId: string, approved: boolean, message?: string) => Promise<AgentSessionSuccessResult>
    syncSkills: (sessionId: string) => Promise<SkillSyncResult>
    syncSkillsForTask: (taskId: string) => Promise<SkillSyncResult>
    learnFromSession: (sessionId: string, message: string) => Promise<SkillSyncResult>
  }
  agentConfig: {
    getProviders: (serverUrl?: string, backendType?: string) => Promise<{ providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } | null>
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
  gitlab: {
    checkCli: () => Promise<GlabCliStatus>
    startAuth: () => Promise<void>
    fetchOrgs: () => Promise<string[]>
    fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
    fetchUserRepos: () => Promise<GitHubRepo[]>
  }
  worktree: {
    setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string, provider: 'github' | 'gitlab') => Promise<string>
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
  secrets: {
    getAll: () => Promise<Secret[]>
    get: (id: string) => Promise<Secret | undefined>
    create: (data: CreateSecretDTO) => Promise<Secret>
    update: (id: string, data: UpdateSecretDTO) => Promise<Secret | undefined>
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
  claudePlugins: {
    getMarketplaceSources: () => Promise<MarketplaceSource[]>
    addMarketplaceSource: (data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }) => Promise<MarketplaceSource>
    removeMarketplaceSource: (id: string) => Promise<boolean>
    fetchCatalog: (sourceId: string) => Promise<MarketplaceCatalog | null>
    discoverPlugins: (searchQuery?: string) => Promise<DiscoverablePlugin[]>
    getInstalledPlugins: () => Promise<InstalledPlugin[]>
    installPlugin: (pluginName: string, marketplaceId: string, scope?: string) => Promise<InstalledPlugin>
    uninstallPlugin: (pluginId: string) => Promise<boolean>
    enablePlugin: (pluginId: string) => Promise<InstalledPlugin | undefined>
    disablePlugin: (pluginId: string) => Promise<InstalledPlugin | undefined>
    getPluginResources: (pluginId: string) => Promise<PluginResources>
  }
  heartbeat: {
    enable: (taskId: string, intervalMinutes?: number) => Promise<WorkfloTask | undefined>
    disable: (taskId: string) => Promise<WorkfloTask | undefined>
    runNow: (taskId: string) => Promise<'sent' | 'no_file' | 'no_agent' | 'error'>
    getLogs: (taskId: string, limit?: number) => Promise<HeartbeatLog[]>
    getStatus: (taskId: string) => Promise<HeartbeatStatusResult | null>
    updateInterval: (taskId: string, intervalMinutes: number) => Promise<WorkfloTask | undefined>
    readFile: (taskId: string) => Promise<string | null>
    writeFile: (taskId: string, content: string) => Promise<boolean>
  }
  app: {
    getVersion: () => Promise<string>
    getLoginItemSettings: () => Promise<{ openAtLogin: boolean; openAsHidden: boolean }>
    setLoginItemSettings: (openAtLogin: boolean) => Promise<{ openAtLogin: boolean; openAsHidden: boolean }>
    getNotificationPermission: () => Promise<'granted' | 'denied'>
    requestNotificationPermission: () => Promise<'granted' | 'denied'>
    getMinimizeToTray: () => Promise<boolean>
    setMinimizeToTray: (enabled: boolean) => Promise<boolean>
  }
  mobile: {
    getInfo: () => Promise<{ url: string; port: number }>
  }
  enterprise: {
    signupInBrowser: (mode: 'register' | 'login') => Promise<{
      userId: string
      email: string
      companies: { id: string; name: string; isPrimary: boolean }[]
    }>
    login: (email: string, password: string) => Promise<{
      userId: string
      email: string
      companies: { id: string; name: string; isPrimary: boolean }[]
    }>
    listCompanies: () => Promise<{ id: string; name: string; isPrimary: boolean }[]>
    selectTenant: (tenantId: string) => Promise<{
      token: string
      tenant: { id: string; name: string }
    }>
    logout: () => Promise<void>
    getSession: () => Promise<{
      isAuthenticated: boolean
      userEmail: string | null
      userId: string | null
      currentTenant: { id: string; name: string } | null
    }>
    refreshToken: () => Promise<{ token: string }>
    apiRequest: (method: string, path: string, body?: unknown) => Promise<unknown>
    getApiUrl: () => Promise<string>
    getJwt: () => Promise<string>
    getAuthTokens: () => Promise<{ accessToken: string; refreshToken: string; tenantId: string | null }>
    enableIframeAuth: () => Promise<{ apiUrl: string }>
    disableIframeAuth: () => Promise<void>
    onSyncComplete: (callback: (data: { success: boolean; syncMs?: number; error?: string }) => void) => () => void
  }
  updater: {
    check: () => Promise<{ success: boolean; version?: string; error?: string }>
    download: () => Promise<{ success: boolean; error?: string }>
    install: () => Promise<void>
    getVersion: () => Promise<string>
    onStatus: (callback: (data: { status: string; version?: string; percent?: number; error?: string; releaseNotes?: string; releaseDate?: string; currentVersion?: string }) => void) => () => void
    onMenuCheckForUpdates: (callback: () => void) => () => void
  }
  agentInstaller: {
    detect: () => Promise<Record<string, { installed: boolean; version: string | null }>>
    install: (agentName: string) => Promise<{ success: boolean; error: string | null; newStatus: Record<string, { installed: boolean; version: string | null }> }>
    getCommand: (agentName: string) => Promise<string>
    onProgress: (callback: (data: { agentName: string; stage: string; output: string; percent: number }) => void) => () => void
  }
  webUtils: {
    getPathForFile: (file: File) => string
  }
  terminal: {
    create: (id: string, cols: number, rows: number, cwd?: string) => Promise<{ pid: number }>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string, expectedPid?: number) => Promise<void>
    getCwd: (id: string, expectedPid?: number) => Promise<{ cwd: string | null }>
    getBuffer: (id: string, lines?: number) => Promise<{ lines: string[] }>
    onData: (callback: (data: { id: string; data: string }) => void) => () => void
    onExit: (callback: (data: { id: string }) => void) => () => void
  }
  onOverdueCheck: (callback: () => void) => () => void
  onTasksRefresh: (callback: () => void) => () => void
  onAgentOutput: (callback: (event: AgentOutputEvent) => void) => () => void
  onAgentOutputBatch: (callback: (event: AgentOutputBatchEvent) => void) => () => void
  onAgentStatus: (callback: (event: AgentStatusEvent) => void) => () => void
  onAgentApproval: (callback: (event: AgentApprovalRequest) => void) => () => void
  onAgentIncompatibleSession: (callback: (event: { taskId: string; agentId: string; error: string }) => void) => () => void
  onTaskUpdated: (callback: (event: { taskId: string; updates: Partial<WorkfloTask> }) => void) => () => void
  onTaskCreated: (callback: (event: { task: WorkfloTask }) => void) => () => void
  onHeartbeatAlert: (callback: (event: HeartbeatAlertEvent) => void) => () => void
  onHeartbeatDisabled: (callback: (event: { taskId: string; reason: string }) => void) => () => void
  onWorktreeProgress: (callback: (event: WorktreeProgressEvent) => void) => () => void
  onGithubDeviceCode: (callback: (code: string) => void) => () => void
  browser: {
    getCdpPort: () => Promise<{ port: number }>
    getTargetId: (webContentsId: number) => Promise<{ targetId: string | null }>
    getCdpTargets: () => Promise<Array<{ id: string; url: string; title: string; type: string; tabId: string }>>
  }
  onGitlabDeviceCode: (callback: (code: string) => void) => () => void
  onOAuthCallback: (callback: (event: { code: string; state: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
