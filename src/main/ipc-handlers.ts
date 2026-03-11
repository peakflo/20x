import { ipcMain, dialog, shell, Notification, app } from 'electron'
import { copyFileSync, existsSync, unlinkSync, readdirSync, statSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, extname } from 'path'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'

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
  UpdateSkillData,
  CreateSecretData,
  UpdateSecretData
} from './database'
import type { AgentManager } from './agent-manager'
import type { GitHubManager } from './github-manager'
import type { WorktreeManager } from './worktree-manager'
import type { SyncManager } from './sync-manager'
import type { PluginRegistry } from './plugins/registry'
import type { OAuthManager } from './oauth/oauth-manager'
import type { EnterpriseAuth } from './enterprise-auth'
import type { ClaudePluginManager } from './claude-plugin-manager'

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
  heartbeatScheduler?: import('./heartbeat-scheduler').HeartbeatScheduler
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

  ipcMain.handle('attachments:resolvePath', (_, taskId: string, attachmentId: string): string | null => {
    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) return null
    const files = readdirSync(dir)
    const match = files.find((f) => f.startsWith(`${attachmentId}-`))
    return match ? join(dir, match) : null
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

  // ── File Viewer handlers ──────────────────────────────────────────────────
  const TABULAR_EXTENSIONS = new Set(['.csv', '.tsv', '.json', '.jsonl', '.xlsx', '.xls', '.parquet'])

  ipcMain.handle('fileViewer:getFileInfo', (_, filePath: string): { exists: boolean; size: number; extension: string; isTabular: boolean } => {
    if (!existsSync(filePath)) return { exists: false, size: 0, extension: '', isTabular: false }
    const stat = statSync(filePath)
    const ext = extname(filePath).toLowerCase()
    return { exists: true, size: stat.size, extension: ext, isTabular: TABULAR_EXTENSIONS.has(ext) }
  })

  ipcMain.handle(
    'fileViewer:readTabularFile',
    (_, filePath: string, limit?: number): { columns: string[]; rows: Record<string, unknown>[]; totalRows: number; truncated: boolean; filePath: string } | { error: string } => {
      const maxRows = limit ?? 500
      if (!existsSync(filePath)) return { error: 'File not found' }

      const ext = extname(filePath).toLowerCase()
      try {
        if (ext === '.csv' || ext === '.tsv') {
          const content = readFileSync(filePath, 'utf-8')
          const result = Papa.parse(content, {
            header: true,
            delimiter: ext === '.tsv' ? '\t' : undefined,
            skipEmptyLines: true,
            preview: maxRows
          })
          const columns = result.meta.fields || []
          const rows = result.data as Record<string, unknown>[]
          // Count total lines for the footer
          let totalRows = rows.length
          if (rows.length === maxRows) {
            // Estimate total by counting newlines
            totalRows = content.split('\n').filter(l => l.trim()).length - 1 // minus header
          }
          return { columns, rows, totalRows, truncated: rows.length < totalRows, filePath }
        }

        if (ext === '.json') {
          const content = readFileSync(filePath, 'utf-8')
          let parsed = JSON.parse(content)
          if (!Array.isArray(parsed)) {
            // If it's a single object, wrap it
            parsed = [parsed]
          }
          const totalRows = parsed.length
          const rows = parsed.slice(0, maxRows) as Record<string, unknown>[]
          const columns = rows.length > 0 ? Object.keys(rows[0]) : []
          return { columns, rows, totalRows, truncated: totalRows > maxRows, filePath }
        }

        if (ext === '.jsonl') {
          const content = readFileSync(filePath, 'utf-8')
          const lines = content.split('\n').filter(l => l.trim())
          const totalRows = lines.length
          const rows = lines.slice(0, maxRows).map(l => JSON.parse(l)) as Record<string, unknown>[]
          const columns = rows.length > 0 ? Object.keys(rows[0]) : []
          return { columns, rows, totalRows, truncated: totalRows > maxRows, filePath }
        }

        if (ext === '.xlsx' || ext === '.xls') {
          const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' })
          const sheetName = workbook.SheetNames[0]
          if (!sheetName) return { error: 'No sheets found in workbook' }
          const sheet = workbook.Sheets[sheetName]
          const allRows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[]
          const totalRows = allRows.length
          const rows = allRows.slice(0, maxRows)
          const columns = rows.length > 0 ? Object.keys(rows[0]) : []
          return { columns, rows, totalRows, truncated: totalRows > maxRows, filePath }
        }

        if (ext === '.parquet') {
          // Parquet requires async — for now return a helpful error
          return { error: 'Parquet support coming soon. Convert to CSV or JSON for preview.' }
        }

        return { error: `Unsupported file type: ${ext}` }
      } catch (err) {
        return { error: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  // Notification handler
  ipcMain.handle('notifications:show', (_, title: string, body: string) => {
    new Notification({ title, body }).show()
  })

  // ── Marimo handlers ────────────────────────────────────────────────────
  ipcMain.handle('marimo:check', async () => {
    const { checkMarimo } = await import('./marimo-server')
    return checkMarimo()
  })

  ipcMain.handle('marimo:isNotebook', async (_, filePath: string) => {
    const { isMarimoNotebook } = await import('./marimo-server')
    return isMarimoNotebook(filePath)
  })

  ipcMain.handle('marimo:launch', async (_, filePath: string, mode?: 'run' | 'edit') => {
    const { launchMarimo } = await import('./marimo-server')
    return launchMarimo(filePath, mode || 'run')
  })

  ipcMain.handle('marimo:stop', async (_, filePath: string) => {
    const { stopMarimo } = await import('./marimo-server')
    return stopMarimo(filePath)
  })

  ipcMain.handle('marimo:status', async (_, filePath: string) => {
    const { getMarimoStatus } = await import('./marimo-server')
    return getMarimoStatus(filePath)
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

  // Dependency check handler
  let depsCheckCache: { gh: boolean; opencode: boolean; opencodeBinary: boolean; claudeCodeBinary: boolean; codexBinary: boolean } | null = null

  ipcMain.handle('deps:check', async () => {
    if (depsCheckCache) {
      // Return cache only if all binaries were found; otherwise re-check
      // so that installing a binary mid-session is picked up.
      const allFound = depsCheckCache.opencodeBinary && depsCheckCache.claudeCodeBinary && depsCheckCache.codexBinary
      if (allFound) return depsCheckCache
      depsCheckCache = null
    }

    // OpenCode: Check if SDK is installed (it's an npm package)
    let opencodeAvailable = false
    try {
      await import('@opencode-ai/sdk')
      opencodeAvailable = true
    } catch {
      opencodeAvailable = false
    }

    // OpenCode binary: Check if the `opencode` command is findable
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

    const [gh, opencodeBin, claudeCodeBin, codexBin] = await Promise.allSettled([
      check('gh --version'),
      check('which opencode'),
      check('which claude'),
      check('which codex')
    ])

    const result = {
      gh: gh.status === 'fulfilled',
      opencode: opencodeAvailable,
      opencodeBinary: opencodeBin.status === 'fulfilled',
      claudeCodeBinary: claudeCodeBin.status === 'fulfilled',
      codexBinary: codexBin.status === 'fulfilled'
    }
    depsCheckCache = result
    return result
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
  ipcMain.handle('enterprise:login', async (_, email: string, password: string) => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    return await enterpriseAuth.login(email, password)
  })

  ipcMain.handle('enterprise:selectTenant', async (_, tenantId: string) => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    const result = await enterpriseAuth.selectTenant(tenantId)

    // Phase 2.6: On enterprise connect, set up API client, sync resources, auto-create task source
    try {
      const { WorkfloApiClient } = await import('./workflo-api-client')
      const { EnterpriseSyncManager } = await import('./enterprise-sync')

      const apiClient = new WorkfloApiClient(enterpriseAuth)
      const enterpriseSyncMgr = new EnterpriseSyncManager(db, apiClient)

      // Get user ID from stored session
      const session = await enterpriseAuth.getSession()
      const userId = session.userId || ''

      // Wire enterprise connection into sync manager
      syncManager.setEnterpriseConnection(apiClient, enterpriseSyncMgr, userId)

      // Run initial sync (agents, skills, MCP servers)
      console.log('[enterprise] Running initial resource sync...')
      const syncResult = await enterpriseSyncMgr.syncAll(userId)
      console.log('[enterprise] Initial sync result:', JSON.stringify(syncResult))

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
    } catch (err) {
      console.error('[enterprise] Post-connect setup error (non-fatal):', err)
    }

    return result
  })

  ipcMain.handle('enterprise:logout', async () => {
    if (!enterpriseAuth) throw new Error('Enterprise auth not available')
    syncManager.clearEnterpriseConnection()
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
        syncManager.setEnterpriseConnection(apiClient, enterpriseSyncMgr, session.userId)
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
}
