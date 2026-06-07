import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type { AgentOutputEvent, AgentOutputBatchEvent, AgentStatusEvent, AgentApprovalRequest, WorktreeProgressEvent } from '../src/renderer/src/types/electron'
import type { WorkfloTask } from '../src/renderer/src/types/index'

// Suppress React act() warnings in happy-dom
;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// Capture event listener callbacks for store tests
export const eventCallbacks = {
  onAgentOutput: null as ((event: AgentOutputEvent) => void) | null,
  onAgentOutputBatch: null as ((event: AgentOutputBatchEvent) => void) | null,
  onAgentStatus: null as ((event: AgentStatusEvent) => void) | null,
  onAgentApproval: null as ((event: AgentApprovalRequest) => void) | null,
  onOverdueCheck: null as (() => void) | null,
  onTaskUpdated: null as ((event: { taskId: string; updates: Partial<WorkfloTask> }) => void) | null,
  onTaskDeleted: null as ((event: { taskId: string }) => void) | null,
  onWorktreeProgress: null as ((event: WorktreeProgressEvent) => void) | null
}

const mockElectronAPI = {
  db: {
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    deleteTask: vi.fn().mockResolvedValue(true),
    getSubtasks: vi.fn().mockResolvedValue([])
  },
  mcpServers: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true),
    testConnection: vi.fn().mockResolvedValue({ status: 'connected', tools: [] })
  },
  agents: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true)
  },
  agentSession: {
    start: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    resume: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    stop: vi.fn().mockResolvedValue({ success: true }),
    stopByTaskId: vi.fn().mockResolvedValue({ success: true, sessionId: null }),
    send: vi.fn().mockResolvedValue({ success: true }),
    sendByTaskId: vi.fn().mockResolvedValue({ success: true, sessionId: null }),
    approve: vi.fn().mockResolvedValue({ success: true }),
    syncSkills: vi.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
    syncSkillsForTask: vi.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
    learnFromSession: vi.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] })
  },
  agentConfig: {
    getProviders: vi.fn().mockResolvedValue(null)
  },
  attachments: {
    pick: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined)
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(undefined),
    showItemInFolder: vi.fn().mockResolvedValue(undefined),
    readTextFile: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(undefined)
  },
  enterprise: {
    login: vi.fn().mockResolvedValue({ userId: 'u1', email: 'test@test.com', companies: [] }),
    signupInBrowser: vi.fn().mockResolvedValue({ userId: 'u1', email: 'test@test.com', companies: [] }),
    selectTenant: vi.fn().mockResolvedValue({ token: 'jwt', tenant: { id: 't1', name: 'Test' } }),
    logout: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue({ isAuthenticated: false, userEmail: null, userId: null, currentTenant: null }),
    listCompanies: vi.fn().mockResolvedValue([]),
    syncResources: vi.fn().mockResolvedValue({}),
    apiRequest: vi.fn().mockResolvedValue({}),
    getJwt: vi.fn().mockResolvedValue(null),
    refreshToken: vi.fn().mockResolvedValue(undefined),
    getAuthTokens: vi.fn().mockResolvedValue({ accessToken: '', refreshToken: '', tenantId: '' }),
    getAiGatewayStatus: vi.fn().mockResolvedValue(null),
    getApiUrl: vi.fn().mockResolvedValue('https://api.peakflo.ai'),
    enableIframeAuth: vi.fn().mockResolvedValue(undefined),
    disableIframeAuth: vi.fn().mockResolvedValue(undefined)
  },
  notifications: {
    show: vi.fn().mockResolvedValue(undefined)
  },
  settings: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue({})
  },
  github: {
    checkCli: vi.fn().mockResolvedValue({ installed: false, authenticated: false }),
    startAuth: vi.fn().mockResolvedValue(undefined),
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchOrgRepos: vi.fn().mockResolvedValue([])
  },
  gitlab: {
    checkCli: vi.fn().mockResolvedValue({ installed: false, authenticated: false }),
    startAuth: vi.fn().mockResolvedValue(undefined),
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchOrgRepos: vi.fn().mockResolvedValue([]),
    fetchUserRepos: vi.fn().mockResolvedValue([])
  },
  worktree: {
    setup: vi.fn().mockResolvedValue(''),
    cleanup: vi.fn().mockResolvedValue(undefined)
  },
  taskSources: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true),
    sync: vi.fn().mockResolvedValue({ source_id: '', imported: 0, updated: 0, errors: [] }),
    exportUpdate: vi.fn().mockResolvedValue(undefined),
    getUsers: vi.fn().mockResolvedValue([]),
    reassign: vi.fn().mockResolvedValue({ success: true })
  },
  skills: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true)
  },
  deps: {
    check: vi.fn().mockResolvedValue({ gh: false, opencode: false })
  },
  env: {
    get: vi.fn().mockResolvedValue(null)
  },
  plugins: {
    list: vi.fn().mockResolvedValue([]),
    getConfigSchema: vi.fn().mockResolvedValue([]),
    resolveOptions: vi.fn().mockResolvedValue([]),
    getActions: vi.fn().mockResolvedValue([]),
    executeAction: vi.fn().mockResolvedValue({ success: true })
  },
  onOverdueCheck: vi.fn((cb: () => void) => {
    eventCallbacks.onOverdueCheck = cb
    return vi.fn()
  }),
  onAgentOutput: vi.fn((cb: (event: AgentOutputEvent) => void) => {
    eventCallbacks.onAgentOutput = cb
    return vi.fn()
  }),
  onAgentOutputBatch: vi.fn((cb: (event: AgentOutputBatchEvent) => void) => {
    eventCallbacks.onAgentOutputBatch = cb
    return vi.fn()
  }),
  onAgentStatus: vi.fn((cb: (event: AgentStatusEvent) => void) => {
    eventCallbacks.onAgentStatus = cb
    return vi.fn()
  }),
  onAgentApproval: vi.fn((cb: (event: AgentApprovalRequest) => void) => {
    eventCallbacks.onAgentApproval = cb
    return vi.fn()
  }),
  onAgentIncompatibleSession: vi.fn((_cb: (event: { taskId: string; agentId: string; error: string }) => void) => {
    return vi.fn()
  }),
  onTaskUpdated: vi.fn((cb: (event: { taskId: string; updates: Partial<WorkfloTask> }) => void) => {
    eventCallbacks.onTaskUpdated = cb
    return vi.fn()
  }),
  onWorktreeProgress: vi.fn((cb: (event: WorktreeProgressEvent) => void) => {
    eventCallbacks.onWorktreeProgress = cb
    return vi.fn()
  }),
  onTaskCreated: vi.fn((_cb: (event: { task: WorkfloTask }) => void) => {
    return vi.fn()
  }),
  onTaskDeleted: vi.fn((cb: (event: { taskId: string }) => void) => {
    eventCallbacks.onTaskDeleted = cb
    return vi.fn()
  }),
  onGithubDeviceCode: vi.fn((_cb: (code: string) => void) => {
    return vi.fn()
  }),
  onGitlabDeviceCode: vi.fn((_cb: (code: string) => void) => {
    return vi.fn()
  }),
  onTasksRefresh: vi.fn((_cb: () => void) => {
    return vi.fn()
  }),
  agentInstaller: {
    detect: vi.fn().mockResolvedValue({}),
    install: vi.fn().mockResolvedValue({ success: true, error: null, newStatus: {} }),
    getCommand: vi.fn().mockResolvedValue(''),
    onProgress: vi.fn((_cb: (data: unknown) => void) => vi.fn())
  },
  app: {
    getVersion: vi.fn().mockResolvedValue('0.0.1')
  },
  updater: {
    check: vi.fn().mockResolvedValue({ success: true }),
    download: vi.fn().mockResolvedValue({ success: true }),
    install: vi.fn().mockResolvedValue(undefined),
    getVersion: vi.fn().mockResolvedValue('0.0.31'),
    onStatus: vi.fn((_cb: (data: unknown) => void) => vi.fn()),
    onMenuCheckForUpdates: vi.fn((_cb: () => void) => vi.fn())
  }
}

Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  configurable: true,
  writable: true
})
