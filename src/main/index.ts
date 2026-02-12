import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { DatabaseManager } from './database'
import { AgentManager } from './agent-manager'
import { GitHubManager } from './github-manager'
import { WorktreeManager } from './worktree-manager'
import { McpToolCaller } from './mcp-tool-caller'
import { SyncManager } from './sync-manager'
import { PluginRegistry } from './plugins/registry'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import { registerIpcHandlers } from './ipc-handlers'

let mainWindow: BrowserWindow | null = null
let db: DatabaseManager | null = null
let agentManager: AgentManager | null = null
let githubManager: GitHubManager | null = null
let worktreeManager: WorktreeManager | null = null
let mcpToolCaller: McpToolCaller | null = null
let syncManager: SyncManager | null = null
let pluginRegistry: PluginRegistry | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()

    // Periodic overdue check — nudges renderer every 60s
    setInterval(() => {
      mainWindow?.webContents.send('overdue:check')
    }, 60_000)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Set main window for managers
  agentManager?.setMainWindow(mainWindow)
  worktreeManager?.setMainWindow(mainWindow)
}

app.whenReady().then(async () => {
  db = new DatabaseManager()
  db.initialize()

  agentManager = new AgentManager(db)
  githubManager = new GitHubManager()
  worktreeManager = new WorktreeManager()

  mcpToolCaller = new McpToolCaller()

  pluginRegistry = new PluginRegistry()
  pluginRegistry.register(new PeakfloPlugin())

  syncManager = new SyncManager(db, mcpToolCaller, pluginRegistry)

  registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry, mcpToolCaller)

  // Check gh CLI status on startup (log only)
  githubManager.checkGhCli().then((status) => {
    console.log('[GitHub] CLI status:', status)
  }).catch(() => {})

  createWindow()

  // Start OpenCode server
  try {
    await agentManager.startServer()
  } catch (error) {
    console.error('Failed to start OpenCode server:', error)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // Stop all agent sessions and server
  agentManager?.stopAllSessions()
  agentManager?.stopServer()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // Ensure cleanup before quitting
  agentManager?.stopAllSessions()
  agentManager?.stopServer()
  mcpToolCaller?.destroy()
})
