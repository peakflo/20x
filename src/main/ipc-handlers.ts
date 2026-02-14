import { ipcMain, dialog, shell, Notification } from 'electron'
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
  mcpToolCaller?: import('./mcp-tool-caller').McpToolCaller
): void {
  ipcMain.handle('db:getTasks', () => {
    return db.getTasks()
  })

  ipcMain.handle('db:getTask', (_, id: string) => {
    return db.getTask(id)
  })

  ipcMain.handle('db:createTask', (_, data: CreateTaskData) => {
    return db.createTask(data)
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

  ipcMain.handle('attachments:open', (_, taskId: string, attachmentId: string) => {
    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) return

    const files = readdirSync(dir)
    const match = files.find((f) => f.startsWith(`${attachmentId}-`))
    if (match) shell.openPath(join(dir, match))
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
  ipcMain.handle('agentSession:start', async (_, agentId: string, taskId: string, workspaceDir?: string) => {
    const sessionId = await agentManager.startSession(agentId, taskId, workspaceDir)
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

  ipcMain.handle('worktree:cleanup', async (_, taskId: string, repos: { fullName: string }[], org: string) => {
    await worktreeManager.cleanupTaskWorkspace(taskId, repos, org)
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

    // GitHub CLI: Check using shell (still need the binary)
    const shell = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
    const check = (cmd: string) =>
      execFileAsync(shell, ['-l', '-c', cmd])
    const [gh] = await Promise.allSettled([
      check('gh --version')
    ])

    return {
      gh: gh.status === 'fulfilled',
      opencode: opencodeAvailable
    }
  })

  // Plugin handlers
  ipcMain.handle('plugin:list', () => {
    return pluginRegistry.list()
  })

  ipcMain.handle('plugin:getConfigSchema', (_, pluginId: string) => {
    const plugin = pluginRegistry.get(pluginId)
    return plugin ? plugin.getConfigSchema() : []
  })

  ipcMain.handle('plugin:resolveOptions', async (_, pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string) => {
    const plugin = pluginRegistry.get(pluginId)
    if (!plugin || !mcpToolCaller) return []
    const mcpServer = mcpServerId ? db.getMcpServer(mcpServerId) : undefined
    const ctx = { db, toolCaller: mcpToolCaller, mcpServer }
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
}
