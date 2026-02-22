import { ipcMain, dialog, shell, Notification, app } from 'electron'
import { copyFileSync, existsSync, unlinkSync, readdirSync, statSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, extname } from 'path'

const execFileAsync = promisify(execFile)
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
  UpdateSkillData
} from './database'
import type { AgentManager } from './agent-manager'
import type { GitHubManager } from './github-manager'
import type { WorktreeManager } from './worktree-manager'
import type { SyncManager } from './sync-manager'
import type { PluginRegistry } from './plugins/registry'
import type { OAuthManager } from './oauth/oauth-manager'

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
  recurrenceScheduler?: import('./recurrence-scheduler').RecurrenceScheduler
): void {
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
    return db.updateTask(id, data)
  })

  ipcMain.handle('db:deleteTask', (_, id: string) => {
    return db.deleteTask(id)
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

  ipcMain.handle('agentSession:send', async (_, sessionId: string, message: string, taskId?: string) => {
    const result = await agentManager.sendMessage(sessionId, message, taskId)
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

  // Track selected task for idle notification visibility check
  ipcMain.on('task:selectedChanged', (_, taskId: string | null) => {
    agentManager.setSelectedTaskId(taskId)
  })

  // Agent Config handlers
  ipcMain.handle('agentConfig:getProviders', async (_, serverUrl?: string) => {
    return await agentManager.getProviders(serverUrl)
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

  ipcMain.handle('github:startAuth', async () => {
    await githubManager.startWebAuth()
  })

  ipcMain.handle('github:fetchOrgs', async () => {
    return await githubManager.fetchUserOrgs()
  })

  ipcMain.handle('github:fetchOrgRepos', async (_, org: string) => {
    return await githubManager.fetchOrgRepos(org)
  })

  // Worktree handlers
  ipcMain.handle('worktree:setup', async (_, taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string) => {
    return await worktreeManager.setupWorkspaceForTask(taskId, repos, org)
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
    return await syncManager.importTasks(sourceId)
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

  // Dependency check handler
  ipcMain.handle('deps:check', async () => {
    // OpenCode: Check if SDK is installed (it's an npm package)
    let opencodeAvailable = false
    try {
      await import('@opencode-ai/sdk')
      opencodeAvailable = true
    } catch {
      opencodeAvailable = false
    }

    // OpenCode binary: Check if the `opencode` command is findable
    // First ensure common paths are in PATH (same as agent-manager does)
    const { homedir } = await import('os')
    const { join: pathJoin, delimiter } = await import('path')
    const customPath = db.getSetting('OPENCODE_BINARY_PATH')
    const extraPaths = [
      ...(customPath ? [customPath] : []),
      pathJoin(homedir(), '.opencode', 'bin'),
      '/usr/local/bin',
      pathJoin(homedir(), '.local', 'bin')
    ].filter(p => !(process.env.PATH || '').includes(p))
    if (extraPaths.length > 0) {
      process.env.PATH = [...extraPaths, process.env.PATH || ''].join(delimiter)
    }

    const loginShell = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
    const check = (cmd: string) =>
      execFileAsync(loginShell, ['-l', '-c', cmd])

    const [gh, opencodeBin] = await Promise.allSettled([
      check('gh --version'),
      check('which opencode')
    ])

    return {
      gh: gh.status === 'fulfilled',
      opencode: opencodeAvailable,
      opencodeBinary: opencodeBin.status === 'fulfilled'
    }
  })

  // Save custom OpenCode binary path
  ipcMain.handle('deps:setOpencodePath', async (_, dirPath: string) => {
    const { join: pathJoin, delimiter } = await import('path')
    const binaryPath = pathJoin(dirPath, 'opencode')
    if (!existsSync(binaryPath)) {
      return { success: false, error: `opencode binary not found at ${binaryPath}` }
    }
    db.setSetting('OPENCODE_BINARY_PATH', dirPath)
    // Also add to PATH immediately
    if (!(process.env.PATH || '').includes(dirPath)) {
      process.env.PATH = [dirPath, process.env.PATH || ''].join(delimiter)
    }
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
}
