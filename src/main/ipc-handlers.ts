import { ipcMain, dialog, shell, Notification, app, session } from 'electron'
import { copyFileSync, existsSync, unlinkSync, readdirSync, statSync, readFileSync } from 'fs'
import { join, basename, extname } from 'path'
import type {
  DatabaseManager,
  CreateTaskData,
  UpdateTaskData,
  FileAttachmentRecord,
  CreateAgentData,
  UpdateAgentData,
  CreateMcpServerData,
  UpdateMcpServerData,
  CreateTaskSourceData,
  UpdateTaskSourceData,
  CreateSkillData,
  UpdateSkillData,
  CreateSecretData,
  UpdateSecretData
} from './database'
import type { AgentManager } from './agent-manager'
import { TaskStatus } from '../shared/constants'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { WorktreeManager } from './worktree-manager'
import type { SyncManager } from './sync-manager'
import type { PluginRegistry } from './plugins/registry'
import type { OAuthManager } from './oauth/oauth-manager'
import type { EnterpriseAuth } from './enterprise-auth'
import type { ClaudePluginManager } from './claude-plugin-manager'
import type { EnterpriseHeartbeat } from './enterprise-heartbeat'
import type { EnterpriseStateSync } from './enterprise-state-sync'

const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.md': 'text/markdown'
}

function getMimeType(filename: string): string {
  return MIME_MAP[extname(filename).toLowerCase()] || 'application/octet-stream'
}

export function registerIpcHandlers(
  db: DatabaseManager,
  agentManager: AgentManager,
  githubManager: GitHubManager,
  worktreeManager: WorktreeManager,
  syncManager: SyncManager,
  pluginRegistry: PluginRegistry,
  mcpToolCaller?: import('./mcp-tool-caller').McpToolCaller,
  oauthManager?: OAuthManager,
  recurrenceScheduler?: import('./recurrence-scheduler').RecurrenceScheduler,
  enterpriseAuth?: EnterpriseAuth,
  claudePluginManager?: ClaudePluginManager,
  heartbeatScheduler?: import('./heartbeat-scheduler').HeartbeatScheduler,
  initialEnterpriseHeartbeat?: EnterpriseHeartbeat,
  initialEnterpriseStateSync?: EnterpriseStateSync,
  gitlabManager?: GitLabManager
): void {
  // Mutable references — created on selectTenant, cleared on logout
  let enterpriseHeartbeat = initialEnterpriseHeartbeat
  let enterpriseStateSync = initialEnterpriseStateSync
  ipcMain.handle('db:getTasks', () => {
    return db.getTasks()
  })

  ipcMain.handle('db:getTask', (_, id: string) => {
    return db.getTask(id)
  })

  ipcMain.handle('db:createTask', (_, data: CreateTaskData) => {
    const task = db.createTask(data)
    // Initialize recurring task if it has a recurrence pattern
    if (task && task.is_recurring && recurrenceScheduler) {
      recurrenceScheduler.initializeRecurringTask(task.id)
    }
    return task
  })

  ipcMain.handle('db:updateTask', (_, id: string, data: UpdateTaskData) => {
    // Capture previous status before updating (for enterprise sync)
    let previousStatus: string | undefined
    if (enterpriseStateSync && data.status) {
      const existing = db.getTask(id)
      if (existing && existing.status !== data.status) {
        previousStatus = existing.status
      }
    }

    const updated = db.updateTask(id, data)

    // Auto-disable heartbeat when task is completed
    if (heartbeatScheduler && data.status === TaskStatus.Completed && updated?.heartbeat_enabled) {
      heartbeatScheduler.disableHeartbeat(id)
    }

    // Record status change event for enterprise sync
    // Note: for completions, only emit task_completed (not both status_changed + completed)
    // to avoid double-counting in downstream aggregation
    if (enterpriseStateSync && previousStatus && updated && data.status) {
      if (data.status === 'completed') {
        enterpriseStateSync.recordTaskCompleted(updated)
      } else {
        enterpriseStateSync.recordTaskStatusChange(updated, previousStatus, data.status)
      }
    }

    // Record feedback event for enterprise sync
    if (enterpriseStateSync && data.feedback_rating && updated) {
      enterpriseStateSync.recordFeedbackSubmitted(updated, data.feedback_rating)
    }

    return updated
  })

  ipcMain.handle('db:deleteTask', (_, id: string) => {
    return db.deleteTask(id)
  })

  ipcMain.handle('db:getSubtasks', (_, parentId: string) => {
    return db.getSubtasks(parentId)
  })

  ipcMain.handle('db:reorderSubtasks', (_, parentId: string, orderedIds: string[]) => {
    db.reorderSubtasks(parentId, orderedIds)
    return true
  })

  // Attachment handlers
  ipcMain.handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(
    'attachments:save',
    (_, taskId: string, filePath: string): FileAttachmentRecord => {
      const id = crypto.randomUUID()
      const filename = basename(filePath)
      const stat = statSync(filePath)
      const dir = db.getAttachmentsDir(taskId)
      const destPath = join(dir, `${id}-${filename}`)

      copyFileSync(filePath, destPath)

      return {
        id,
        filename,
        size: stat.size,
        mime_type: getMimeType(filename),
        added_at: new Date().toISOString()
      }
    }
  )

  ipcMain.handle('attachments:remove', (_, taskId: string, attachmentId: string) => {
    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) return

    const files = readdirSync(dir)
    const match = files.find((f) => f.startsWith(`${attachmentId}-`))
    if (match) unlinkSync(join(dir, match))
  })

  ipcMain.handle('tasks:getWorkspaceDir', (_, taskId: string): string => {
    return db.getWorkspaceDir(taskId)
  })

  ipcMain.handle('attachments:open', (_, taskId: string, attachmentId: string) => {
    console.log('[IPC] attachments:open called:', { taskId, attachmentId })

    const dir = db.getAttachmentsDir(taskId)
    console.log('[IPC] Attachments directory:', dir)

    if (!existsSync(dir)) {
      console.log('[IPC] Attachments directory does not exist')
      return
    }

    const files = readdirSync(dir)
    console.log('[IPC] Files in directory:', files)

    const match = files.find((f) => f.startsWith(`${attachmentId}-`))
    console.log('[IPC] Matched file:', match)

    if (match) {
      const filePath = join(dir, match)
      console.log('[IPC] Opening file:', filePath)
      shell.openPath(filePath)
    } else {
      console.log('[IPC] No matching file found for attachment ID:', attachmentId)
    }
  })

  ipcMain.handle('attachments:download', (_, taskId: string, attachmentId: string) => {
    console.log('[IPC] attachments:download called:', { taskId, attachmentId })

    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) {
      console.error('[IPC] Attachments directory does not exist')
      return
    }

    const files = readdirSync(dir)
    const match = files.find((f) => f.startsWith(`${attachmentId}-`))

    if (match) {
      const sourcePath = join(dir, match)
      // Extract filename without the UUID prefix
      // Format: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-filename.ext" (UUID is 36 chars)
      const filename = match.substring(37) // Skip UUID (36 chars) + dash (1 char)

      // Get user's Downloads folder
      const downloadsPath = app.getPath('downloads')
      const destPath = join(downloadsPath, filename)

      console.log('[IPC] Copying file from:', sourcePath)
      console.log('[IPC] Copying file to:', destPath)

      try {
        copyFileSync(sourcePath, destPath)
        console.log('[IPC] File copied successfully')

        // Show the file in Finder/Explorer
        shell.showItemInFolder(destPath)
      } catch (error) {
        console.error('[IPC] Failed to copy file:', error)
        throw error
      }
    } else {
      console.error('[IPC] No matching file found for attachment ID:', attachmentId)
      throw new Error('Attachment file not found')
    }
  })

  // Shell handlers
  ipcMain.handle('shell:openPath', (_, filePath: string) => {
    if (existsSync(filePath)) shell.openPath(filePath)
  })

  ipcMain.handle('shell:showItemInFolder', (_, filePath: string) => {
    if (existsSync(filePath)) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:readTextFile', (_, filePath: string): { content: string; size: number } | null => {
    if (!existsSync(filePath)) return null
    const stat = statSync(filePath)
    // Limit preview to 50KB
    if (stat.size > 50 * 1024) return { content: '', size: stat.size }
    const content = readFileSync(filePath, 'utf-8')
    return { content, size: stat.size }
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    await shell.openExternal(url)
  })

  // Notification handler
  ipcMain.handle('notifications:show', (_, title: string, body: string) => {
    new Notification({ title, body }).show()
  })

  // Agent handlers
  ipcMain.handle('agent:getAll', () => {
    return db.getAgents()
  })

  ipcMain.handle('agent:get', (_, id: string) => {
    return db.getAgent(id)
  })

  ipcMain.handle('agent:create', (_, data: CreateAgentData) => {
    return db.createAgent(data)
  })

  ipcMain.handle('agent:update', (_, id: string, data: UpdateAgentData) => {
    return db.updateAgent(id, data)
  })

  ipcMain.handle('agent:delete', (_, id: string) => {
    return db.deleteAgent(id)
  })

  // Agent Session handlers
  ipcMain.handle('agentSession:start', async (_, agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => {
    const sessionId = await agentManager.startSession(agentId, taskId, workspaceDir, skipInitialPrompt)
    return { sessionId }
  })

  ipcMain.handle('agentSession:resume', async (_, agentId: string, taskId: string, ocSessionId: string) => {
    const sessionId = await agentManager.resumeSession(agentId, taskId, ocSessionId)
    if (!sessionId) {
      // Session ended normally (task completed/reviewed) — session_id already cleared.
      // Return ended flag so the renderer can clean up without an error.
      return { sessionId: '', ended: true }
    }
    return { sessionId }
  })

  ipcMain.handle('agentSession:abort', async (_, sessionId: string) => {
    await agentManager.abortSession(sessionId)
    return { success: true }
  })

  ipcMain.handle('agentSession:stop', async (_, sessionId: string) => {
    await agentManager.stopSession(sessionId)
    return { success: true }
  })

  ipcMain.handle('agentSession:send', async (_, sessionId: string, message: string, taskId?: string, agentId?: string) => {
    const result = await agentManager.sendMessage(sessionId, message, taskId, agentId)
    return { success: true, ...result }
  })

  ipcMain.handle('agentSession:approve', async (_, sessionId: string, approved: boolean, message?: string) => {
    await agentManager.respondToPermission(sessionId, approved, message)
    return { success: true }
  })

  ipcMain.handle('agentSession:syncSkills', (_, sessionId: string) => {
    return agentManager.syncSkillsFromWorkspace(sessionId)
  })

  ipcMain.handle('agentSession:syncSkillsForTask', (_, taskId: string) => {
    return agentManager.syncSkillsForTask(taskId)
  })

  ipcMain.handle('agentSession:learnFromSession', async (_, sessionId: string, message: string) => {
    return await agentManager.learnFromSession(sessionId, message)
  })

  // Agent Config handlers
  ipcMain.handle('agentConfig:getProviders', async (_, serverUrl?: string, backendType?: string) => {
    return await agentManager.getProviders(serverUrl, undefined, backendType)
  })


  // MCP Server handlers
  ipcMain.handle('mcp:getAll', () => {
    return db.getMcpServers()
  })

  ipcMain.handle('mcp:get', (_, id: string) => {
    return db.getMcpServer(id)
  })

  ipcMain.handle('mcp:create', (_, data: CreateMcpServerData) => {
    return db.createMcpServer(data)
  })

  ipcMain.handle('mcp:update', (_, id: string, data: UpdateMcpServerData) => {
    mcpToolCaller?.killSession(id)
    return db.updateMcpServer(id, data)
  })

  ipcMain.handle('mcp:delete', (_, id: string) => {
    mcpToolCaller?.killSession(id)
    return db.deleteMcpServer(id)
  })

  ipcMain.handle('mcp:testConnection', async (_, serverData: { id?: string; name: string; type?: string; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }) => {
    const result = await agentManager.testMcpServer(serverData)
    // Persist discovered tools to DB if a server ID was provided and test succeeded
    if (serverData.id && result.status === 'connected' && result.tools) {
      db.updateMcpServerTools(serverData.id, result.tools)
    }
    return result
  })

  // Settings handlers
  ipcMain.handle('settings:get', (_, key: string) => {
    return db.getSetting(key) ?? null
  })

  ipcMain.handle('settings:set', (_, key: string, value: string) => {
    db.setSetting(key, value)
  })

  ipcMain.handle('settings:getAll', () => {
    return db.getAllSettings()
  })

  // Environment variable handlers
  ipcMain.handle('env:get', (_, key: string) => {
    return process.env[key] ?? null
  })

  // GitHub handlers
  ipcMain.handle('github:checkCli', async () => {
    return await githubManager.checkGhCli()
  })

  ipcMain.handle('github:startAuth', async (event) => {
    await githubManager.startWebAuth((code) => {
      event.sender.send('github:deviceCode', code)
    })
  })

  ipcMain.handle('github:fetchOrgs', async () => {
    return await githubManager.fetchUserOrgs()
  })

  ipcMain.handle('github:fetchOrgRepos', async (_, org: string) => {
    return await githubManager.fetchOrgRepos(org)
  })

  ipcMain.handle('github:fetchUserRepos', async () => {
    return await githubManager.fetchUserRepos()
  })

  ipcMain.handle('github:fetchCollaborators', async (_, owner: string, repo: string) => {
    return await githubManager.fetchRepoCollaborators(owner, repo)
  })

  // GitLab handlers
  ipcMain.handle('gitlab:checkCli', async () => {
    if (!gitlabManager) return { installed: false, authenticated: false }
    return await gitlabManager.checkGlabCli()
  })

  ipcMain.handle('gitlab:startAuth', async (event) => {
    if (!gitlabManager) throw new Error('GitLab manager not initialized')
    await gitlabManager.startWebAuth((code) => {
      event.sender.send('gitlab:deviceCode', code)
    })
  })

  ipcMain.handle('gitlab:fetchOrgs', async () => {
    if (!gitlabManager) return []
    return await gitlabManager.fetchUserOrgs()
  })

  ipcMain.handle('gitlab:fetchOrgRepos', async (_, org: string) => {
    if (!gitlabManager) return []
    return await gitlabManager.fetchOrgRepos(org)
  })

  ipcMain.handle('gitlab:fetchUserRepos', async () => {
    if (!gitlabManager) return []
    return await gitlabManager.fetchUserRepos()
  })

  // Worktree handlers
  ipcMain.handle('worktree:setup', async (_, taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string, provider?: 'github' | 'gitlab') => {
    const resolvedProvider = provider || (db.getSetting('git_provider') as 'github' | 'gitlab' | null) || 'github'
    return await worktreeManager.setupWorkspaceForTask(taskId, repos, org, resolvedProvider)
  })

  ipcMain.handle('worktree:cleanup', async (_, taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean) => {
    await worktreeManager.cleanupTaskWorkspace(taskId, repos, org, removeTaskDir ?? true)
  })

  // Task Source handlers
  ipcMain.handle('taskSource:getAll', () => {
    return db.getTaskSources()
  })

  ipcMain.handle('taskSource:get', (_, id: string) => {
    return db.getTaskSource(id)
  })

  ipcMain.handle('taskSource:create', (_, data: CreateTaskSourceData) => {
    return db.createTaskSource(data)
  })

  ipcMain.handle('taskSource:update', (_, id: string, data: UpdateTaskSourceData) => {
    return db.updateTaskSource(id, data)
  })

  ipcMain.handle('taskSource:delete', (_, id: string) => {
    return db.deleteTaskSource(id)
  })

  ipcMain.handle('taskSource:sync', async (_, sourceId: string) => {
    const result = await syncManager.importTasks(sourceId)

    // After sync, flush pending events to Workflo (non-blocking)
    if (enterpriseStateSync) {
      enterpriseStateSync.flush().catch((err) => {
        console.warn('[ipc] Enterprise state sync flush error (non-fatal):', err)
      })
    }

    return result
  })

  ipcMain.handle('taskSource:exportUpdate', async (_, taskId: string, fields: Record<string, unknown>) => {
    await syncManager.exportTaskUpdate(taskId, fields)
  })

  ipcMain.handle('taskSource:getUsers', (_, sourceId: string) => {
    return syncManager.getSourceUsers(sourceId)
  })

  ipcMain.handle('taskSource:reassign', (_, taskId: string, userIds: string[], assigneeDisplay: string) => {
    return syncManager.reassignTask(taskId, userIds, assigneeDisplay)
  })

  // Skill handlers
  ipcMain.handle('skills:getAll', () => {
    return db.getSkills()
  })

  ipcMain.handle('skills:get', (_, id: string) => {
    return db.getSkill(id)
  })

  ipcMain.handle('skills:create', (_, data: CreateSkillData) => {
    return db.createSkill(data)
  })

  ipcMain.handle('skills:update', (_, id: string, data: UpdateSkillData) => {
    return db.updateSkill(id, data)
  })

  ipcMain.handle('skills:delete', (_, id: string) => {
    return db.deleteSkill(id)
  })

  // Secret handlers
  ipcMain.handle('secrets:getAll', () => {
    return db.getSecrets()
  })

  ipcMain.handle('secrets:get', (_, id: string) => {
    return db.getSecret(id)
  })

  ipcMain.handle('secrets:create', (_, data: CreateSecretData) => {
    return db.createSecret(data)
  })

  ipcMain.handle('secrets:update', (_, id: string, data: UpdateSecretData) => {
    return db.updateSecret(id, data)
  })

  ipcMain.handle('secrets:delete', (_, id: string) => {
    return db.deleteSecret(id)
  })

  // Dependency check handler — delegates to the shared detectInstalledAgents()
  // which returns Record<string, { installed: boolean; version: string | null }>
  let depsCheckCache: Record<string, { installed: boolean; version: string | null }> | null = null

  ipcMain.handle('deps:check', async () => {
    if (depsCheckCache) {
      // Return cache only if all agent binaries were found; otherwise re-check
      const allFound = depsCheckCache.claudeCode?.installed && depsCheckCache.opencode?.installed && depsCheckCache.codex?.installed
      if (allFound) return depsCheckCache
      depsCheckCache = null
    }

    // Augment PATH with custom opencode path and common bin dirs before detection
    const { homedir } = await import('os')
    const { join: pathJoin, delimiter } = await import('path')
    const customPath = db.getSetting('OPENCODE_BINARY_PATH')
    const isWin = process.platform === 'win32'
    const extraPaths = [
      ...(customPath ? [customPath] : []),
      pathJoin(homedir(), '.opencode', 'bin'),
      ...(isWin
        ? [pathJoin(homedir(), 'AppData', 'Roaming', 'npm')]
        : ['/usr/local/bin']),
      pathJoin(homedir(), '.local', 'bin')
    ].filter(p => !(process.env.PATH || '').includes(p))
    if (extraPaths.length > 0) {
      process.env.PATH = [...extraPaths, process.env.PATH || ''].join(delimiter)
    }

    const { detectInstalledAgents } = await import('./agent-installer/detect.js')
    const result = await detectInstalledAgents()
    depsCheckCache = result
    return result
  })

  // Save custom OpenCode binary path
  ipcMain.handle('deps:setOpencodePath', async (_, dirPath: string) => {
    const { join: pathJoin, delimiter } = await import('path')
    const binaryName = process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
    const binaryPath = pathJoin(dirPath, binaryName)
    // Also check for .exe on Windows
    const altPath = process.platform === 'win32' ? pathJoin(dirPath, 'opencode.exe') : null
    if (!existsSync(binaryPath) && (!altPath || !existsSync(altPath))) {
      return { success: false, error: `opencode binary not found at ${binaryPath}` }
    }
    db.setSetting('OPENCODE_BINARY_PATH', dirPath)
    // Also add to PATH immediately
    if (!(process.env.PATH || '').includes(dirPath)) {
      process.env.PATH = [dirPath, process.env.PATH || ''].join(delimiter)
    }
    // Invalidate deps cache so next check picks up the new path
    depsCheckCache = null
    return { success: true }
  })

  // Plugin handlers
  ipcMain.handle('plugin:list', () => {
    return pluginRegistry.list()
  })

  ipcMain.handle('plugin:getConfigSchema', (_, pluginId: string) => {
    const plugin = pluginRegistry.get(pluginId)
    return plugin ? plugin.getConfigSchema() : []
  })

  ipcMain.handle('plugin:getDocumentation', (_, pluginId: string) => {
    return pluginRegistry.getDocumentation(pluginId)
  })

  ipcMain.handle('plugin:resolveOptions', async (_, pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string) => {
    const plugin = pluginRegistry.get(pluginId)
    if (!plugin || !mcpToolCaller) return []
    const mcpServer = mcpServerId ? db.getMcpServer(mcpServerId) : undefined
    const ctx = { db, toolCaller: mcpToolCaller, mcpServer, oauthManager, sourceId }
    return await plugin.resolveOptions(resolverKey, config, ctx)
  })

  ipcMain.handle('plugin:getActions', (_, pluginId: string, config: Record<string, unknown>) => {
    const plugin = pluginRegistry.get(pluginId)
    return plugin ? plugin.getActions(config) : []
  })

  ipcMain.handle('plugin:executeAction', async (_, actionId: string, taskId: string, sourceId: string, input?: string) => {
    const task = db.getTask(taskId)
    if (!task) return { success: false, error: 'Task not found' }
    return await syncManager.executeAction(actionId, task, input, sourceId)
  })

  // OAuth handlers
  ipcMain.handle('oauth:startFlow', async (_, provider: string, config: Record<string, unknown>) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    return oauthManager.generateAuthUrl(provider, config)
  })

  ipcMain.handle('oauth:exchangeCode', async (_, provider: string, code: string, state: string, sourceId: string) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    await oauthManager.exchangeCode(provider, code, state, sourceId)
  })

  ipcMain.handle('oauth:startLocalhostFlow', async (_, provider: string, config: Record<string, unknown>, sourceId: string) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    await oauthManager.startLocalhostOAuthFlow(provider, config, sourceId)
  })

  ipcMain.handle('oauth:getValidToken', async (_, sourceId: string) => {
    if (!oauthManager) return null
    return await oauthManager.getValidToken(sourceId)
  })

  ipcMain.handle('oauth:revokeToken', async (_, sourceId: string) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    await oauthManager.revokeToken(sourceId)
  })

  // MCP Server OAuth handlers (spec-compliant discovery flow)
  ipcMain.handle('mcp:startOAuthFlow', async (_, mcpServerId: string) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    return await oauthManager.startMcpServerOAuthFlow(mcpServerId)
  })

  ipcMain.handle('mcp:getOAuthStatus', (_, mcpServerId: string) => {
    if (!oauthManager) return { connected: false }
    return oauthManager.getMcpServerOAuthStatus(mcpServerId)
  })

  ipcMain.handle('mcp:revokeOAuthToken', async (_, mcpServerId: string) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    await oauthManager.revokeMcpServerToken(mcpServerId)
  })

  ipcMain.handle('mcp:probeForAuth', async (_, serverUrl: string) => {
    const { OAuthManager: OAuthMgr } = await import('./oauth/oauth-manager')
    return await OAuthMgr.probeForAuth(serverUrl)
  })

  ipcMain.handle('mcp:submitManualClientId', async (_, mcpServerId: string, clientId: string) => {
    if (!oauthManager) throw new Error('OAuth manager not initialized')
    return await oauthManager.completeManualRegistration(mcpServerId, clientId)
  })

  // App version
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion()
  })

  // Crash log path
  ipcMain.handle('app:getCrashLogPath', async () => {
    const { getCrashLogPath } = await import('./crash-logger')
    return getCrashLogPath()
  })

  // App preferences handlers
  ipcMain.handle('app:getLoginItemSettings', () => {
    return app.getLoginItemSettings()
  })

  ipcMain.handle('app:setLoginItemSettings', (_, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false
    })
    return app.getLoginItemSettings()
  })

  ipcMain.handle('app:getNotificationPermission', async () => {
    if (Notification.isSupported()) {
      return 'granted'
    }
    return 'denied'
  })

  ipcMain.handle('app:requestNotificationPermission', async () => {
    return Notification.isSupported() ? 'granted' : 'denied'
  })

  ipcMain.handle('app:getMinimizeToTray', async () => {
    const result = await db.getSetting('minimize_to_tray')
    return result === 'true'
  })

  ipcMain.handle('app:setMinimizeToTray', async (_, enabled: boolean) => {
    await db.setSetting('minimize_to_tray', enabled.toString())
    return enabled
  })

  // Mobile web UI info — include auth token in URL hash so mobile SPA can authenticate
  ipcMain.handle('mobile:getInfo', () => {
    const port = 20620
    const token = db.getSetting('mobile_auth_token') || ''
    const hash = token ? `#token=${token}` : ''
    return { url: `http://localhost:${port}/${hash}`, port }
  })

  // Enterprise auth handlers

  ipcMain.handle('enterprise:signupInBrowser', async (_, mode: 'register' | 'login') => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')

    const { AuthCallbackServer } = await import('./oauth/auth-callback-server')
    const callbackServer = new AuthCallbackServer()

    try {
      // Start localhost server and get the redirect URI
      const redirectUri = await callbackServer.start()

      // Derive the workflow-builder frontend URL from the API URL
      const apiUrl = enterpriseAuth.getApiUrl()
      const parsed = new URL(apiUrl)
      let frontendOrigin: string
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        parsed.port = '4000'
        frontendOrigin = parsed.origin
      } else {
        parsed.hostname = parsed.hostname.replace('-api.', '-app.').replace(/^api\./, 'app.')
        frontendOrigin = parsed.origin
      }

      const path = mode === 'register' ? '/register' : '/login'
      const signupUrl = `${frontendOrigin}${path}?redirect_uri=${encodeURIComponent(redirectUri)}`

      // Open the URL in the user's default browser
      await shell.openExternal(signupUrl)

      // Wait for the callback with tokens
      const tokens = await callbackServer.waitForCallback()

      // Use the received tokens to log in
      const result = await enterpriseAuth.loginWithTokens(tokens.access_token, tokens.refresh_token)

      return result
    } catch (err) {
      callbackServer.stop()
      throw err
    }
  })

  ipcMain.handle('enterprise:login', async (_, email: string, password: string) => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return await enterpriseAuth.login(email, password)
  })

  ipcMain.handle('enterprise:listCompanies', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return await enterpriseAuth.listCompanies()
  })

  ipcMain.handle('enterprise:selectTenant', async (event, tenantId: string) => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    const result = await enterpriseAuth.selectTenant(tenantId)

    // Return auth result immediately — run post-connect setup (sync, MCP, etc.) in background
    // so the UI shows "Connected" right away with a "Syncing..." indicator.
    const sender = event.sender

    // Fire-and-forget: run sync and setup in background
    ;(async () => {
      try {
        const { WorkfloApiClient } = await import('./workflo-api-client')
        const { EnterpriseSyncManager } = await import('./enterprise-sync')

        const apiClient = new WorkfloApiClient(enterpriseAuth!)
        const enterpriseSyncMgr = new EnterpriseSyncManager(db, apiClient)

        // Get user ID from stored session
        const session = await enterpriseAuth!.getSession()
        const userId = session.userId || ''

        // Start enterprise heartbeat (1-min interval)
        {
          const { EnterpriseHeartbeat: EHB } = await import('./enterprise-heartbeat')
          if (!enterpriseHeartbeat) {
            enterpriseHeartbeat = new EHB(apiClient)
          } else {
            enterpriseHeartbeat.setApiClient(apiClient)
          }
          enterpriseHeartbeat.start({
            userEmail: session.userEmail || undefined,
            userName: session.userEmail || undefined
          })
        }

        // Wire enterprise state sync
        {
          const { EnterpriseStateSync: ESS } = await import('./enterprise-state-sync')
          if (!enterpriseStateSync) {
            enterpriseStateSync = new ESS(apiClient)
          } else {
            enterpriseStateSync.setApiClient(apiClient)
          }
          enterpriseStateSync.setUserName(session.userEmail || 'Unknown')
          agentManager.setEnterpriseStateSync(enterpriseStateSync)

          // Attach state sync to heartbeat so events flush every 60s
          if (enterpriseHeartbeat) {
            enterpriseHeartbeat.setStateSync(enterpriseStateSync)
          }
        }

        // Wire enterprise connection into sync manager (after state sync is ready)
        syncManager.setEnterpriseConnection(apiClient, enterpriseSyncMgr, userId, enterpriseStateSync)

        // Pass enterprise auth to agent manager so it can inject JWT into MCP Dev Server requests
        agentManager.setEnterpriseAuth(enterpriseAuth!)

        // Run initial sync (agents, skills, MCP servers)
        const syncStart = Date.now()
        console.log('[enterprise] Running initial resource sync...')
        const syncResult = await enterpriseSyncMgr.syncAll(userId)
        const syncMs = Date.now() - syncStart
        console.log(`[enterprise] Initial sync completed in ${syncMs}ms — result:`, JSON.stringify(syncResult))

        // Auto-register MCP Dev Server (Workflo's MCP endpoint that exposes
        // workflows-as-tools, integrations, datastores, and data tables).
        // Uses the enterprise JWT for authentication — no separate API key needed.
        try {
          const mcpDevServerName = '[Workflo] MCP Dev Server'
          const apiUrl = enterpriseAuth!.getApiUrl()
          const mcpDevUrl = `${apiUrl}/api/mcp/dev/mcp`

          const localServers = db.getMcpServers()
          const existingMcpDev = localServers.find((s) => s.name === mcpDevServerName)

          if (existingMcpDev) {
            // Update URL in case environment changed (e.g. local → stage → prod)
            if (existingMcpDev.url !== mcpDevUrl) {
              db.updateMcpServer(existingMcpDev.id, { url: mcpDevUrl })
              console.log('[enterprise] Updated MCP Dev Server URL:', mcpDevUrl)
            }
          } else {
            db.createMcpServer({
              name: mcpDevServerName,
              type: 'remote',
              url: mcpDevUrl,
              headers: {},
              // The enterprise JWT is injected dynamically by the MCP transport
              // layer (via EnterpriseAuth.getJwt()), not stored statically here.
              // The MCP client retrieves a fresh JWT before each connection.
            })
            console.log('[enterprise] Registered MCP Dev Server:', mcpDevUrl)
          }
        } catch (mcpErr) {
          console.warn('[enterprise] Failed to register MCP Dev Server (non-fatal):', mcpErr)
        }

        // Auto-add all [Workflo] MCP servers to the default agent so they're
        // immediately available without manual configuration
        try {
          const allServers = db.getMcpServers()
          const workfloServers = allServers.filter((s) => s.name.startsWith('[Workflo]'))

          const defaultAgent = db.getAgents().find((a) => a.is_default)
          if (defaultAgent && workfloServers.length > 0) {
            const config = { ...defaultAgent.config }
            const mcpServers = [...(config.mcp_servers || [])]
            let added = 0

            for (const server of workfloServers) {
              const alreadyPresent = mcpServers.some((s) =>
                typeof s === 'string' ? s === server.id : s.serverId === server.id
              )
              if (!alreadyPresent) {
                mcpServers.push(server.id)
                added++
              }
            }

            if (added > 0) {
              config.mcp_servers = mcpServers
              db.updateAgent(defaultAgent.id, { config })
              console.log(`[enterprise] Added ${added} Workflo MCP server(s) to default agent`)
            }
          }
        } catch (err) {
          console.warn('[enterprise] Failed to add MCP servers to default agent (non-fatal):', err)
        }

        // Auto-create Peakflo task source if none exists
        const existingSources = db.getTaskSources()
        const hasPeakfloSource = existingSources.some(
          (s) => s.plugin_id === 'peakflo' && (s.config as Record<string, unknown>).enterprise_mode
        )
        if (!hasPeakfloSource) {
          console.log('[enterprise] Auto-creating Peakflo task source...')
          db.createTaskSource({
            mcp_server_id: null,
            name: `Workflo (${result.tenant.name})`,
            plugin_id: 'peakflo',
            config: {
              enterprise_mode: true,
              status_filter: 'all',
              auto_sync_interval: 5
            },
            list_tool: '',
            list_tool_args: {},
            update_tool: '',
            update_tool_args: {}
          })
        }

        // Notify renderer that background sync is complete
        if (!sender.isDestroyed()) {
          sender.send('enterprise:syncComplete', { success: true, syncMs })
        }
      } catch (err) {
        console.error('[enterprise] Post-connect setup error (non-fatal):', err)
        if (!sender.isDestroyed()) {
          sender.send('enterprise:syncComplete', {
            success: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    })()

    return result
  })

  ipcMain.handle('enterprise:logout', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    syncManager.clearEnterpriseConnection()
    agentManager.setEnterpriseAuth(null)

    // Stop enterprise heartbeat
    if (enterpriseHeartbeat) {
      enterpriseHeartbeat.stop()
    }

    // Clear enterprise state sync from agent manager
    agentManager.setEnterpriseStateSync(null)

    return await enterpriseAuth.logout()
  })

  ipcMain.handle('enterprise:getSession', async () => {
    if (!enterpriseAuth) {
      return { isAuthenticated: false, userEmail: null, userId: null, currentTenant: null }
    }
    const session = await enterpriseAuth.getSession()

    // Restore enterprise connection if authenticated but sync manager not wired
    if (session.isAuthenticated && session.currentTenant && session.userId) {
      try {
        const { WorkfloApiClient } = await import('./workflo-api-client')
        const { EnterpriseSyncManager } = await import('./enterprise-sync')

        const apiClient = new WorkfloApiClient(enterpriseAuth)
        const enterpriseSyncMgr = new EnterpriseSyncManager(db, apiClient)
        // Restore enterprise heartbeat
        try {
          const { EnterpriseHeartbeat: EHB } = await import('./enterprise-heartbeat')
          if (!enterpriseHeartbeat) {
            enterpriseHeartbeat = new EHB(apiClient)
          } else {
            enterpriseHeartbeat.setApiClient(apiClient)
          }
          if (!enterpriseHeartbeat.isRunning) {
            enterpriseHeartbeat.start({
              userEmail: session.userEmail || undefined,
              userName: session.userEmail || undefined
            })
          }
        } catch (err) {
          console.error('[enterprise] Failed to restore heartbeat:', err)
        }

        // Restore enterprise state sync
        try {
          const { EnterpriseStateSync: ESS } = await import('./enterprise-state-sync')
          if (!enterpriseStateSync) {
            enterpriseStateSync = new ESS(apiClient)
          } else {
            enterpriseStateSync.setApiClient(apiClient)
          }
          enterpriseStateSync.setUserName(session.userEmail || 'Unknown')
          agentManager.setEnterpriseStateSync(enterpriseStateSync)

          // Attach state sync to heartbeat so events flush every 60s
          if (enterpriseHeartbeat) {
            enterpriseHeartbeat.setStateSync(enterpriseStateSync)
          }
        } catch (err) {
          console.error('[enterprise] Failed to restore state sync:', err)
        }

        // Wire enterprise connection (after state sync is ready)
        syncManager.setEnterpriseConnection(apiClient, enterpriseSyncMgr, session.userId, enterpriseStateSync)
      } catch (err) {
        console.error('[enterprise] Failed to restore connection:', err)
      }
    }

    return session
  })

  ipcMain.handle('enterprise:refreshToken', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return await enterpriseAuth.refreshToken()
  })

  ipcMain.handle('enterprise:apiRequest', async (_, method: string, path: string, body?: unknown) => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return await enterpriseAuth.apiRequest(method, path, body)
  })

  ipcMain.handle('enterprise:getApiUrl', () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return enterpriseAuth.getApiUrl()
  })

  ipcMain.handle('enterprise:getJwt', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return enterpriseAuth.getJwt()
  })

  ipcMain.handle('enterprise:getAuthTokens', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return enterpriseAuth.getAuthTokens()
  })

  // Inject Authorization header for iframe requests to the enterprise API.
  // The interceptor is scoped to the API URL so it only affects API-bound requests.
  let iframeAuthEnabled = false

  ipcMain.handle('enterprise:enableIframeAuth', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    if (iframeAuthEnabled) return { apiUrl: enterpriseAuth.getApiUrl() }

    const apiUrl = enterpriseAuth.getApiUrl()
    const filter = { urls: [`${apiUrl}/*`] }

    session.defaultSession.webRequest.onBeforeSendHeaders(filter, async (details, callback) => {
      if (iframeAuthEnabled && enterpriseAuth) {
        try {
          const jwt = await enterpriseAuth.getJwt()
          details.requestHeaders['Authorization'] = `Bearer ${jwt}`
        } catch {
          // If JWT retrieval fails, proceed without auth
        }
      }
      callback({ requestHeaders: details.requestHeaders })
    })

    iframeAuthEnabled = true
    return { apiUrl }
  })

  ipcMain.handle('enterprise:disableIframeAuth', () => {
    iframeAuthEnabled = false
  })

  // ── Claude Plugin Marketplace handlers ─────────────────────

  // Marketplace sources
  ipcMain.handle('claudePlugin:getMarketplaceSources', () => {
    return claudePluginManager?.getMarketplaceSources() ?? []
  })

  ipcMain.handle('claudePlugin:addMarketplaceSource', (_, data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return claudePluginManager.addMarketplaceSource(data)
  })

  ipcMain.handle('claudePlugin:removeMarketplaceSource', (_, id: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return claudePluginManager.removeMarketplaceSource(id)
  })

  // Fetch catalog for a marketplace
  ipcMain.handle('claudePlugin:fetchCatalog', async (_, sourceId: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return await claudePluginManager.fetchMarketplaceCatalog(sourceId)
  })

  // Discover plugins from all marketplaces
  ipcMain.handle('claudePlugin:discoverPlugins', async (_, searchQuery?: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return await claudePluginManager.discoverPlugins(searchQuery)
  })

  // Installed plugins
  ipcMain.handle('claudePlugin:getInstalledPlugins', () => {
    return claudePluginManager?.getInstalledPlugins() ?? []
  })

  ipcMain.handle('claudePlugin:installPlugin', async (_, pluginName: string, marketplaceId: string, scope?: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return await claudePluginManager.installPlugin(pluginName, marketplaceId, scope)
  })

  ipcMain.handle('claudePlugin:uninstallPlugin', async (_, pluginId: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return await claudePluginManager.uninstallPlugin(pluginId)
  })

  ipcMain.handle('claudePlugin:enablePlugin', (_, pluginId: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return claudePluginManager.enablePlugin(pluginId)
  })

  ipcMain.handle('claudePlugin:disablePlugin', (_, pluginId: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return claudePluginManager.disablePlugin(pluginId)
  })

  ipcMain.handle('claudePlugin:getPluginResources', (_, pluginId: string) => {
    if (!claudePluginManager) throw new Error('ClaudePluginManager not initialized')
    return claudePluginManager.getPluginResources(pluginId)
  })

  // ── Heartbeat handlers ────────────────────────────────────

  ipcMain.handle('heartbeat:enable', (_, taskId: string, intervalMinutes?: number) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    heartbeatScheduler.enableHeartbeat(taskId, intervalMinutes)
    return db.getTask(taskId)
  })

  ipcMain.handle('heartbeat:disable', (_, taskId: string) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    heartbeatScheduler.disableHeartbeat(taskId)
    return db.getTask(taskId)
  })

  ipcMain.handle('heartbeat:runNow', async (_, taskId: string) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    return await heartbeatScheduler.runNow(taskId)
  })

  ipcMain.handle('heartbeat:getLogs', (_, taskId: string, limit?: number) => {
    return db.getHeartbeatLogs(taskId, limit)
  })

  ipcMain.handle('heartbeat:getStatus', (_, taskId: string) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    const task = db.getTask(taskId)
    if (!task) return null
    return {
      enabled: task.heartbeat_enabled,
      intervalMinutes: task.heartbeat_interval_minutes,
      lastCheckAt: task.heartbeat_last_check_at,
      nextCheckAt: task.heartbeat_next_check_at,
      hasHeartbeatFile: heartbeatScheduler.hasHeartbeatFile(taskId)
    }
  })

  ipcMain.handle('heartbeat:updateInterval', (_, taskId: string, intervalMinutes: number) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    heartbeatScheduler.enableHeartbeat(taskId, intervalMinutes)
    return db.getTask(taskId)
  })

  ipcMain.handle('heartbeat:readFile', (_, taskId: string) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    return heartbeatScheduler.readHeartbeatFile(taskId)
  })

  ipcMain.handle('heartbeat:writeFile', (_, taskId: string, content: string) => {
    if (!heartbeatScheduler) throw new Error('HeartbeatScheduler not initialized')
    heartbeatScheduler.writeHeartbeatFile(taskId, content)
    return true
  })

  // ── Agent Installer IPC handlers ──────────────────────────

  ipcMain.handle('agent-installer:detect', async () => {
    const { detectInstalledAgents } = await import('./agent-installer/detect.js')
    return detectInstalledAgents()
  })

  ipcMain.handle('agent-installer:install', async (event, { agentName }: { agentName: string }) => {
    const { installAgent } = await import('./agent-installer/install.js')
    return installAgent(agentName, (progress: { stage: string; output: string; percent: number }) => {
      event.sender.send('agent-installer:progress', { agentName, ...progress })
    })
  })

  ipcMain.handle('agent-installer:get-install-command', async (_, { agentName }: { agentName: string }) => {
    const { getInstallCommand } = await import('./agent-installer/install.js')
    return getInstallCommand(agentName)
  })
}
