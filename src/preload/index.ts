import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  db: {
    getTasks: (): Promise<unknown[]> => ipcRenderer.invoke('db:getTasks'),
    getTask: (id: string): Promise<unknown> => ipcRenderer.invoke('db:getTask', id),
    createTask: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('db:createTask', data),
    updateTask: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('db:updateTask', id, data),
    deleteTask: (id: string): Promise<boolean> => ipcRenderer.invoke('db:deleteTask', id)
  },
  attachments: {
    pick: (): Promise<string[]> => ipcRenderer.invoke('attachments:pick'),
    save: (taskId: string, filePath: string): Promise<unknown> =>
      ipcRenderer.invoke('attachments:save', taskId, filePath),
    remove: (taskId: string, attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:remove', taskId, attachmentId),
    open: (taskId: string, attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:open', taskId, attachmentId)
  },
  notifications: {
    show: (title: string, body: string): Promise<void> =>
      ipcRenderer.invoke('notifications:show', title, body)
  },
  agents: {
    getAll: (): Promise<unknown[]> => ipcRenderer.invoke('agent:getAll'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('agent:get', id),
    create: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('agent:create', data),
    update: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('agent:update', id, data),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('agent:delete', id)
  },
  mcpServers: {
    getAll: (): Promise<unknown[]> => ipcRenderer.invoke('mcp:getAll'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('mcp:get', id),
    create: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('mcp:delete', id),
    testConnection: (data: { id?: string; name: string; type?: string; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }): Promise<{ status: string; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }> =>
      ipcRenderer.invoke('mcp:testConnection', data)
  },
  agentSession: {
    start: (agentId: string, taskId: string, workspaceDir?: string): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke('agentSession:start', agentId, taskId, workspaceDir),
    abort: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:abort', sessionId),
    stop: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:stop', sessionId),
    send: (sessionId: string, message: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:send', sessionId, message),
    approve: (sessionId: string, approved: boolean, message?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:approve', sessionId, approved, message)
  },
  agentConfig: {
    getProviders: (serverUrl?: string): Promise<{ providers: any[]; default: Record<string, string> } | null> =>
      ipcRenderer.invoke('agentConfig:getProviders', serverUrl)
  },
  onOverdueCheck: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('overdue:check', handler)
    return () => ipcRenderer.removeListener('overdue:check', handler)
  },
  onAgentOutput: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('agent:output', handler)
    return () => ipcRenderer.removeListener('agent:output', handler)
  },
  onAgentStatus: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('agent:status', handler)
    return () => ipcRenderer.removeListener('agent:status', handler)
  },
  onAgentApproval: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('agent:approval', handler)
    return () => ipcRenderer.removeListener('agent:approval', handler)
  },
  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('settings:set', key, value),
    getAll: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:getAll')
  },
  github: {
    checkCli: (): Promise<{ installed: boolean; authenticated: boolean; username?: string }> =>
      ipcRenderer.invoke('github:checkCli'),
    startAuth: (): Promise<void> => ipcRenderer.invoke('github:startAuth'),
    fetchOrgs: (): Promise<string[]> => ipcRenderer.invoke('github:fetchOrgs'),
    fetchOrgRepos: (org: string): Promise<unknown[]> =>
      ipcRenderer.invoke('github:fetchOrgRepos', org)
  },
  worktree: {
    setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string): Promise<string> =>
      ipcRenderer.invoke('worktree:setup', taskId, repos, org),
    cleanup: (taskId: string, repos: { fullName: string }[], org: string): Promise<void> =>
      ipcRenderer.invoke('worktree:cleanup', taskId, repos, org)
  },
  onWorktreeProgress: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('worktree:progress', handler)
    return () => ipcRenderer.removeListener('worktree:progress', handler)
  }
})
