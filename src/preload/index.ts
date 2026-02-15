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
  shell: {
    openPath: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('shell:showItemInFolder', filePath),
    readTextFile: (filePath: string): Promise<{ content: string; size: number } | null> =>
      ipcRenderer.invoke('shell:readTextFile', filePath),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('shell:openExternal', url)
  },
  oauth: {
    startFlow: (provider: string, config: Record<string, unknown>): Promise<string> =>
      ipcRenderer.invoke('oauth:startFlow', provider, config),
    exchangeCode: (provider: string, code: string, state: string, sourceId: string): Promise<void> =>
      ipcRenderer.invoke('oauth:exchangeCode', provider, code, state, sourceId),
    getValidToken: (sourceId: string): Promise<string | null> =>
      ipcRenderer.invoke('oauth:getValidToken', sourceId),
    revokeToken: (sourceId: string): Promise<void> =>
      ipcRenderer.invoke('oauth:revokeToken', sourceId)
  },
  onOAuthCallback: (callback: (event: { code: string; state: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { code: string; state: string }): void => callback(data)
    ipcRenderer.on('oauth:callback', handler)
    return () => ipcRenderer.removeListener('oauth:callback', handler)
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
    resume: (agentId: string, taskId: string, ocSessionId: string): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke('agentSession:resume', agentId, taskId, ocSessionId),
    abort: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:abort', sessionId),
    stop: (sessionId: string, resetTaskStatus?: boolean): Promise<{ success: boolean }> => {
      const reset = resetTaskStatus ?? false
      console.log(`[Preload] stop called with sessionId=${sessionId}, resetTaskStatus=${resetTaskStatus} (resolved to ${reset})`)
      return ipcRenderer.invoke('agentSession:stop', sessionId, reset)
    },
    send: (sessionId: string, message: string, taskId?: string): Promise<{ success: boolean; newSessionId?: string }> =>
      ipcRenderer.invoke('agentSession:send', sessionId, message, taskId),
    approve: (sessionId: string, approved: boolean, message?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:approve', sessionId, approved, message),
    syncSkills: (sessionId: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> =>
      ipcRenderer.invoke('agentSession:syncSkills', sessionId),
    syncSkillsForTask: (taskId: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> =>
      ipcRenderer.invoke('agentSession:syncSkillsForTask', taskId),
    learnFromSession: (sessionId: string, rating: number, comment?: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> =>
      ipcRenderer.invoke('agentSession:learnFromSession', sessionId, rating, comment)
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
  onAgentIncompatibleSession: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('agent:incompatible-session', handler)
    return () => ipcRenderer.removeListener('agent:incompatible-session', handler)
  },
  onTaskUpdated: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('task:updated', handler)
    return () => ipcRenderer.removeListener('task:updated', handler)
  },
  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('settings:set', key, value),
    getAll: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:getAll')
  },
  env: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('env:get', key)
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
  taskSources: {
    getAll: (): Promise<unknown[]> => ipcRenderer.invoke('taskSource:getAll'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('taskSource:get', id),
    create: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('taskSource:create', data),
    update: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('taskSource:update', id, data),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('taskSource:delete', id),
    sync: (sourceId: string): Promise<unknown> => ipcRenderer.invoke('taskSource:sync', sourceId),
    exportUpdate: (taskId: string, fields: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke('taskSource:exportUpdate', taskId, fields),
    getUsers: (sourceId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('taskSource:getUsers', sourceId),
    reassign: (taskId: string, userIds: string[], assigneeDisplay: string): Promise<unknown> =>
      ipcRenderer.invoke('taskSource:reassign', taskId, userIds, assigneeDisplay)
  },
  skills: {
    getAll: (): Promise<unknown[]> => ipcRenderer.invoke('skills:getAll'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('skills:get', id),
    create: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('skills:create', data),
    update: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('skills:update', id, data),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('skills:delete', id)
  },
  deps: {
    check: (): Promise<{ gh: boolean; opencode: boolean }> =>
      ipcRenderer.invoke('deps:check')
  },
  plugins: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('plugin:list'),
    getConfigSchema: (pluginId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:getConfigSchema', pluginId),
    resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:resolveOptions', pluginId, resolverKey, config, mcpServerId, sourceId),
    getActions: (pluginId: string, config: Record<string, unknown>): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:getActions', pluginId, config),
    executeAction: (actionId: string, taskId: string, sourceId: string, input?: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:executeAction', actionId, taskId, sourceId, input)
  },
  onWorktreeProgress: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('worktree:progress', handler)
    return () => ipcRenderer.removeListener('worktree:progress', handler)
  },
  app: {
    getLoginItemSettings: (): Promise<{ openAtLogin: boolean; openAsHidden: boolean }> =>
      ipcRenderer.invoke('app:getLoginItemSettings'),
    setLoginItemSettings: (openAtLogin: boolean): Promise<{ openAtLogin: boolean; openAsHidden: boolean }> =>
      ipcRenderer.invoke('app:setLoginItemSettings', openAtLogin),
    getNotificationPermission: (): Promise<'granted' | 'denied'> =>
      ipcRenderer.invoke('app:getNotificationPermission'),
    requestNotificationPermission: (): Promise<'granted' | 'denied'> =>
      ipcRenderer.invoke('app:requestNotificationPermission'),
    getMinimizeToTray: (): Promise<boolean> =>
      ipcRenderer.invoke('app:getMinimizeToTray'),
    setMinimizeToTray: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('app:setMinimizeToTray', enabled)
  }
})
