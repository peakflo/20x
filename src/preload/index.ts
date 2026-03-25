import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  db: {
    getTasks: (): Promise<unknown[]> => ipcRenderer.invoke('db:getTasks'),
    getTask: (id: string): Promise<unknown> => ipcRenderer.invoke('db:getTask', id),
    createTask: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('db:createTask', data),
    updateTask: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('db:updateTask', id, data),
    deleteTask: (id: string): Promise<boolean> => ipcRenderer.invoke('db:deleteTask', id),
    getSubtasks: (parentId: string): Promise<unknown[]> => ipcRenderer.invoke('db:getSubtasks', parentId),
    reorderSubtasks: (parentId: string, orderedIds: string[]): Promise<boolean> => ipcRenderer.invoke('db:reorderSubtasks', parentId, orderedIds)
  },
  tasks: {
    getWorkspaceDir: (taskId: string): Promise<string> =>
      ipcRenderer.invoke('tasks:getWorkspaceDir', taskId)
  },
  attachments: {
    pick: (): Promise<string[]> => ipcRenderer.invoke('attachments:pick'),
    save: (taskId: string, filePath: string): Promise<unknown> =>
      ipcRenderer.invoke('attachments:save', taskId, filePath),
    remove: (taskId: string, attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:remove', taskId, attachmentId),
    open: (taskId: string, attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:open', taskId, attachmentId),
    download: (taskId: string, attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:download', taskId, attachmentId)
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
    startLocalhostFlow: (provider: string, config: Record<string, unknown>, sourceId: string): Promise<void> =>
      ipcRenderer.invoke('oauth:startLocalhostFlow', provider, config, sourceId),
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
      ipcRenderer.invoke('mcp:testConnection', data),
    startOAuthFlow: (mcpServerId: string): Promise<{ needsManualClientId?: boolean }> =>
      ipcRenderer.invoke('mcp:startOAuthFlow', mcpServerId),
    getOAuthStatus: (mcpServerId: string): Promise<{ connected: boolean; expiresAt?: string }> =>
      ipcRenderer.invoke('mcp:getOAuthStatus', mcpServerId),
    revokeOAuthToken: (mcpServerId: string): Promise<void> =>
      ipcRenderer.invoke('mcp:revokeOAuthToken', mcpServerId),
    probeForAuth: (serverUrl: string): Promise<{ requiresAuth: boolean }> =>
      ipcRenderer.invoke('mcp:probeForAuth', serverUrl),
    submitManualClientId: (mcpServerId: string, clientId: string): Promise<{ needsManualClientId?: boolean }> =>
      ipcRenderer.invoke('mcp:submitManualClientId', mcpServerId, clientId)
  },
  agentSession: {
    start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke('agentSession:start', agentId, taskId, workspaceDir, skipInitialPrompt),
    resume: (agentId: string, taskId: string, ocSessionId: string): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke('agentSession:resume', agentId, taskId, ocSessionId),
    abort: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:abort', sessionId),
    stop: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:stop', sessionId),
    send: (sessionId: string, message: string, taskId?: string, agentId?: string): Promise<{ success: boolean; newSessionId?: string }> =>
      ipcRenderer.invoke('agentSession:send', sessionId, message, taskId, agentId),
    approve: (sessionId: string, approved: boolean, message?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agentSession:approve', sessionId, approved, message),
    syncSkills: (sessionId: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> =>
      ipcRenderer.invoke('agentSession:syncSkills', sessionId),
    syncSkillsForTask: (taskId: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> =>
      ipcRenderer.invoke('agentSession:syncSkillsForTask', taskId),
    learnFromSession: (sessionId: string, message: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> =>
      ipcRenderer.invoke('agentSession:learnFromSession', sessionId, message)
  },
  agentConfig: {
    getProviders: (serverUrl?: string): Promise<{ providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } | null> =>
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
  onAgentOutputBatch: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('agent:output-batch', handler)
    return () => ipcRenderer.removeListener('agent:output-batch', handler)
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
  onTaskCreated: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('task:created', handler)
    return () => ipcRenderer.removeListener('task:created', handler)
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
      ipcRenderer.invoke('github:fetchOrgRepos', org),
    fetchUserRepos: (): Promise<unknown[]> =>
      ipcRenderer.invoke('github:fetchUserRepos'),
    fetchCollaborators: (owner: string, repo: string): Promise<unknown[]> =>
      ipcRenderer.invoke('github:fetchCollaborators', owner, repo)
  },
  worktree: {
    setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string): Promise<string> =>
      ipcRenderer.invoke('worktree:setup', taskId, repos, org),
    cleanup: (taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean): Promise<void> =>
      ipcRenderer.invoke('worktree:cleanup', taskId, repos, org, removeTaskDir)
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
  secrets: {
    getAll: (): Promise<unknown[]> => ipcRenderer.invoke('secrets:getAll'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('secrets:get', id),
    create: (data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('secrets:create', data),
    update: (id: string, data: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('secrets:update', id, data),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('secrets:delete', id)
  },
  deps: {
    check: (): Promise<Record<string, { installed: boolean; version: string | null }>> =>
      ipcRenderer.invoke('deps:check'),
    setOpencodePath: (dirPath: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('deps:setOpencodePath', dirPath)
  },
  plugins: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('plugin:list'),
    getConfigSchema: (pluginId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:getConfigSchema', pluginId),
    getDocumentation: (pluginId: string): Promise<string | null> =>
      ipcRenderer.invoke('plugin:getDocumentation', pluginId),
    resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:resolveOptions', pluginId, resolverKey, config, mcpServerId, sourceId),
    getActions: (pluginId: string, config: Record<string, unknown>): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:getActions', pluginId, config),
    executeAction: (actionId: string, taskId: string, sourceId: string, input?: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:executeAction', actionId, taskId, sourceId, input)
  },
  claudePlugins: {
    getMarketplaceSources: (): Promise<unknown[]> =>
      ipcRenderer.invoke('claudePlugin:getMarketplaceSources'),
    addMarketplaceSource: (data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('claudePlugin:addMarketplaceSource', data),
    removeMarketplaceSource: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('claudePlugin:removeMarketplaceSource', id),
    fetchCatalog: (sourceId: string): Promise<unknown> =>
      ipcRenderer.invoke('claudePlugin:fetchCatalog', sourceId),
    discoverPlugins: (searchQuery?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('claudePlugin:discoverPlugins', searchQuery),
    getInstalledPlugins: (): Promise<unknown[]> =>
      ipcRenderer.invoke('claudePlugin:getInstalledPlugins'),
    installPlugin: (pluginName: string, marketplaceId: string, scope?: string): Promise<unknown> =>
      ipcRenderer.invoke('claudePlugin:installPlugin', pluginName, marketplaceId, scope),
    uninstallPlugin: (pluginId: string): Promise<boolean> =>
      ipcRenderer.invoke('claudePlugin:uninstallPlugin', pluginId),
    enablePlugin: (pluginId: string): Promise<unknown> =>
      ipcRenderer.invoke('claudePlugin:enablePlugin', pluginId),
    disablePlugin: (pluginId: string): Promise<unknown> =>
      ipcRenderer.invoke('claudePlugin:disablePlugin', pluginId),
    getPluginResources: (pluginId: string): Promise<unknown> =>
      ipcRenderer.invoke('claudePlugin:getPluginResources', pluginId)
  },
  heartbeat: {
    enable: (taskId: string, intervalMinutes?: number): Promise<unknown> =>
      ipcRenderer.invoke('heartbeat:enable', taskId, intervalMinutes),
    disable: (taskId: string): Promise<unknown> =>
      ipcRenderer.invoke('heartbeat:disable', taskId),
    runNow: (taskId: string): Promise<unknown> =>
      ipcRenderer.invoke('heartbeat:runNow', taskId),
    getLogs: (taskId: string, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke('heartbeat:getLogs', taskId, limit),
    getStatus: (taskId: string): Promise<unknown> =>
      ipcRenderer.invoke('heartbeat:getStatus', taskId),
    updateInterval: (taskId: string, intervalMinutes: number): Promise<unknown> =>
      ipcRenderer.invoke('heartbeat:updateInterval', taskId, intervalMinutes),
    readFile: (taskId: string): Promise<string | null> =>
      ipcRenderer.invoke('heartbeat:readFile', taskId),
    writeFile: (taskId: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('heartbeat:writeFile', taskId, content)
  },
  onHeartbeatAlert: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('heartbeat:alert', handler)
    return () => ipcRenderer.removeListener('heartbeat:alert', handler)
  },
  onHeartbeatDisabled: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('heartbeat:disabled', handler)
    return () => ipcRenderer.removeListener('heartbeat:disabled', handler)
  },
  onWorktreeProgress: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('worktree:progress', handler)
    return () => ipcRenderer.removeListener('worktree:progress', handler)
  },
  onGithubDeviceCode: (callback: (code: string) => void): (() => void) => {
    const handler = (_: unknown, code: string): void => callback(code)
    ipcRenderer.on('github:deviceCode', handler)
    return () => ipcRenderer.removeListener('github:deviceCode', handler)
  },
  app: {
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke('app:getVersion'),
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
  },
  mobile: {
    getInfo: (): Promise<{ url: string; port: number }> =>
      ipcRenderer.invoke('mobile:getInfo')
  },
  enterprise: {
    login: (email: string, password: string): Promise<{
      userId: string
      email: string
      companies: { id: string; name: string; isPrimary: boolean }[]
    }> => ipcRenderer.invoke('enterprise:login', email, password),
    selectTenant: (tenantId: string): Promise<{
      token: string
      tenant: { id: string; name: string }
    }> => ipcRenderer.invoke('enterprise:selectTenant', tenantId),
    logout: (): Promise<void> =>
      ipcRenderer.invoke('enterprise:logout'),
    getSession: (): Promise<{
      isAuthenticated: boolean
      userEmail: string | null
      userId: string | null
      currentTenant: { id: string; name: string } | null
    }> => ipcRenderer.invoke('enterprise:getSession'),
    refreshToken: (): Promise<{ token: string }> =>
      ipcRenderer.invoke('enterprise:refreshToken'),
    apiRequest: (method: string, path: string, body?: unknown): Promise<unknown> =>
      ipcRenderer.invoke('enterprise:apiRequest', method, path, body)
  },
  updater: {
    check: (): Promise<{ success: boolean; version?: string; error?: string }> =>
      ipcRenderer.invoke('updater:check'),
    download: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('updater:download'),
    install: (): Promise<void> =>
      ipcRenderer.invoke('updater:install'),
    onStatus: (callback: (data: { status: string; version?: string; percent?: number; error?: string; releaseNotes?: string }) => void): (() => void) => {
      const handler = (_: unknown, data: { status: string; version?: string; percent?: number; error?: string; releaseNotes?: string }): void => callback(data)
      ipcRenderer.on('updater:status', handler)
      return () => ipcRenderer.removeListener('updater:status', handler)
    }
  },
  agentInstaller: {
    detect: (): Promise<Record<string, { installed: boolean; version: string | null }>> =>
      ipcRenderer.invoke('agent-installer:detect'),
    install: (agentName: string): Promise<{ success: boolean; error: string | null; newStatus: Record<string, { installed: boolean; version: string | null }> }> =>
      ipcRenderer.invoke('agent-installer:install', { agentName }),
    getCommand: (agentName: string): Promise<string> =>
      ipcRenderer.invoke('agent-installer:get-install-command', { agentName }),
    onProgress: (callback: (data: { agentName: string; stage: string; output: string; percent: number }) => void): (() => void) => {
      const handler = (_: unknown, data: { agentName: string; stage: string; output: string; percent: number }): void => callback(data)
      ipcRenderer.on('agent-installer:progress', handler)
      return () => ipcRenderer.removeListener('agent-installer:progress', handler)
    }
  },
  webUtils: {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  }
})
