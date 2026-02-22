import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Suppress React act() warnings in happy-dom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Capture event listener callbacks for store tests
export const eventCallbacks = {
  onAgentOutput: null as ((event: any) => void) | null,
  onAgentStatus: null as ((event: any) => void) | null,
  onAgentApproval: null as ((event: any) => void) | null,
  onOverdueCheck: null as (() => void) | null,
  onTaskUpdated: null as ((event: any) => void) | null,
  onTaskNavigate: null as ((taskId: string) => void) | null,
  onWorktreeProgress: null as ((event: any) => void) | null
}

const mockElectronAPI = {
  db: {
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    deleteTask: vi.fn().mockResolvedValue(true)
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
    send: vi.fn().mockResolvedValue({ success: true }),
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
    readTextFile: vi.fn().mockResolvedValue(null)
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
  onAgentOutput: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.onAgentOutput = cb
    return vi.fn()
  }),
  onAgentStatus: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.onAgentStatus = cb
    return vi.fn()
  }),
  onAgentApproval: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.onAgentApproval = cb
    return vi.fn()
  }),
  onAgentIncompatibleSession: vi.fn((_cb: (event: any) => void) => {
    return vi.fn()
  }),
  onTaskUpdated: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.onTaskUpdated = cb
    return vi.fn()
  }),
  onTaskNavigate: vi.fn((cb: (taskId: string) => void) => {
    eventCallbacks.onTaskNavigate = cb
    return vi.fn()
  }),
  reportSelectedTask: vi.fn(),
  onWorktreeProgress: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.onWorktreeProgress = cb
    return vi.fn()
  }),
  onTaskCreated: vi.fn((_cb: (event: any) => void) => {
    return vi.fn()
  })
}

;(globalThis as any).window = {
  ...(globalThis as any).window,
  electronAPI: mockElectronAPI
}
