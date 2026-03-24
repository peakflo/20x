import { execFile, execSync } from 'child_process'
import { readdirSync } from 'fs'
import { app, BrowserWindow, net, protocol, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { DatabaseManager } from './database'
import { AgentManager } from './agent-manager'
import { GitHubManager } from './github-manager'
import { WorktreeManager } from './worktree-manager'
import { McpToolCaller } from './mcp-tool-caller.js'
import { SyncManager } from './sync-manager'
import { OAuthManager } from './oauth/oauth-manager'
import { PluginRegistry } from './plugins/registry'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import { LinearPlugin } from './plugins/linear-plugin'
import { HubSpotPlugin } from './plugins/hubspot-plugin'
import { GitHubIssuesPlugin } from './plugins/github-issues-plugin'
import { NotionPlugin } from './plugins/notion-plugin'
import { registerIpcHandlers } from './ipc-handlers'
import { EnterpriseAuth } from './enterprise-auth'
import { RecurrenceScheduler } from './recurrence-scheduler'
import { HeartbeatScheduler } from './heartbeat-scheduler'
import { ClaudePluginManager } from './claude-plugin-manager'
import { EnterpriseHeartbeat } from './enterprise-heartbeat'
import { EnterpriseStateSync } from './enterprise-state-sync'
import { setTaskApiNotifier, setTranscriptProvider, stopTaskApiServer } from './task-api-server'
import { startSecretBroker, stopSecretBroker, writeSecretShellWrapper } from './secret-broker'
import { startMobileApiServer, stopMobileApiServer, broadcastToMobileClients, setMobileApiNotifier } from './mobile-api-server'
import { initAutoUpdater } from './auto-updater'
import { initCrashLogger } from './crash-logger'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let db: DatabaseManager | null = null
let agentManager: AgentManager | null = null
let githubManager: GitHubManager | null = null
let worktreeManager: WorktreeManager | null = null
let mcpToolCaller: McpToolCaller | null = null
let syncManager: SyncManager | null = null
let pluginRegistry: PluginRegistry | null = null
let oauthManager: OAuthManager | null = null
let enterpriseAuth: EnterpriseAuth | null = null
let recurrenceScheduler: RecurrenceScheduler | null = null
let heartbeatScheduler: HeartbeatScheduler | null = null
let claudePluginManager: ClaudePluginManager | null = null
let enterpriseHeartbeatInstance: EnterpriseHeartbeat | null = null
let enterpriseStateSyncInstance: EnterpriseStateSync | null = null
let isShuttingDown = false

async function shutdownAppServices(): Promise<void> {
  enterpriseHeartbeatInstance?.stop()
  heartbeatScheduler?.stop()

  await agentManager?.stopAllSessions()
  await agentManager?.stopServer()

  mcpToolCaller?.destroy()
  oauthManager?.destroy()
  stopSecretBroker()
  stopMobileApiServer()
  stopTaskApiServer()

  // Kill orphaned task-management-mcp processes (spawned by opencode, not cleaned up on exit)
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq task-management-mcp*"', { stdio: 'ignore' })
    } else {
      execSync('pkill -f "task-management-mcp\\.js"', { stdio: 'ignore' })
    }
    console.log('[Shutdown] Killed orphaned task-management-mcp processes')
  } catch {
    // pkill/taskkill exits non-zero if no processes matched — that's fine
  }

  db?.close()

  if (tray) {
    tray.destroy()
    tray = null
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f172a',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#0f172a', symbolColor: '#94a3b8', height: 36 },
          icon: is.dev ? join(__dirname, '../../resources/icon.ico') : join(process.resourcesPath, 'icon.ico')
        }),
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

    // Initialize auto-updater (only in production)
    if (!is.dev && mainWindow) {
      initAutoUpdater(mainWindow)
    }

    // Start recurrence scheduler
    if (recurrenceScheduler && mainWindow) {
      recurrenceScheduler.start(mainWindow)
    }

    // Start heartbeat scheduler
    if (heartbeatScheduler && mainWindow) {
      heartbeatScheduler.start(mainWindow)
    }

    // Periodic overdue check — nudges renderer every 60s
    setInterval(() => {
      mainWindow?.webContents.send('overdue:check')
    }, 60_000)
  })

  // Auto-reload on renderer crash (blank screen recovery)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Main] Renderer crashed: reason=${details.reason}, exitCode=${details.exitCode}`)
    if (details.reason !== 'clean-exit') {
      console.log('[Main] Attempting to reload renderer...')
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload()
        }
      }, 1000)
    }
  })

  // Log renderer console errors
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) { // 2 = warning, 3 = error
      console.error(`[Renderer ${level === 3 ? 'ERROR' : 'WARN'}] ${message}`)
    }
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

  mainWindow.on('close', async (event) => {
    if (!isQuitting) {
      const minimizeToTray = await db?.getSetting('minimize_to_tray')
      if (minimizeToTray === 'true') {
        event.preventDefault()
        mainWindow?.hide()

        // Create tray if it doesn't exist
        if (!tray && db) {
          createTray()
        }
        return
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Set main window for managers
  agentManager?.setMainWindow(mainWindow)
  worktreeManager?.setMainWindow(mainWindow)

  // Wire up task-api-server notifications to the renderer
  setTaskApiNotifier((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
  })

  // Wire up transcript provider for subtask MCP agents to access sibling transcripts
  if (agentManager) {
    setTranscriptProvider((taskId) => agentManager!.getTranscriptForTask(taskId))
  }

  // Wire up mobile-api-server notifications to the renderer
  setMobileApiNotifier((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
  })
}

function createTray(): void {
  if (tray) return

  // Create a simple tray icon (16x16 transparent icon)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAESSURBVDiNrdI9S8NAGMDx/5Wk1YKDi4ODQ3FQcHMQP4CDg4uDk4ubk4iDnyAf4O/gIji4CA5FEBwcnJycHBwcXBwcXJRSq7aJ8VDSpk0VfMbj7rn/cffcI6SUOKWllNhKKeF0OhGllLBtG9M0kVLidDqoqsrl5SWxWIxoNIphGOi6Trlcplgskkql8Pl8AMD3+0ilUuF6vZZKqYLruigI+Hw+FAoF3t/fJZPJ0O/3WSwW/H6/bDQaXF9fs1gsMAwDy7Jwu91Eo1EcDgfFYpFsNovH46FarZJMJpmammJjY4N6vY6qqgSDQdrtNgC2bTMYDOh0Oui6jqIoKIqCZVmYponf72cwGGDbNgBCCIQQf9o/6Ad8dIxRqBjmAAAAAElFTkSuQmCC'
  )

  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show 20x',
      click: () => {
        mainWindow?.show()
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('20x')
  tray.setContextMenu(contextMenu)

  // Show window on tray icon click (platform specific)
  tray.on('click', () => {
    mainWindow?.show()
  })
}

// Register custom protocol for OAuth callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('nuanu', process.execPath, [
      join(process.argv[1])
    ])
  }
} else {
  app.setAsDefaultProtocolClient('nuanu')
}

// Handle OAuth callback deep links
app.on('open-url', (event, url) => {
  event.preventDefault()

  console.log('[OAuth] Received callback URL:', url)

  // Parse: nuanu://oauth/callback?code=xxx&state=yyy
  try {
    const parsedUrl = new URL(url)
    console.log('[OAuth] Parsed URL - protocol:', parsedUrl.protocol, 'hostname:', parsedUrl.hostname, 'pathname:', parsedUrl.pathname)

    // Check if this is an OAuth callback (nuanu://oauth/callback)
    if (parsedUrl.protocol === 'nuanu:' && parsedUrl.hostname === 'oauth' && parsedUrl.pathname === '/callback') {
      const code = parsedUrl.searchParams.get('code')
      const state = parsedUrl.searchParams.get('state')

      console.log('[OAuth] Extracted code:', code ? 'present' : 'missing', 'state:', state ? 'present' : 'missing')

      if (code && state) {
        // If window isn't ready, wait for it
        if (!mainWindow) {
          console.log('[OAuth] Main window not ready, waiting...')
          const checkWindow = setInterval(() => {
            if (mainWindow) {
              clearInterval(checkWindow)
              console.log('[OAuth] Sending callback to renderer')
              mainWindow.webContents.send('oauth:callback', { code, state })
            }
          }, 100)
          // Timeout after 10 seconds
          setTimeout(() => clearInterval(checkWindow), 10000)
        } else {
          console.log('[OAuth] Sending callback to renderer')
          mainWindow.webContents.send('oauth:callback', { code, state })
        }
      } else {
        console.error('[OAuth] Missing code or state in callback URL')
      }
    } else {
      console.log('[OAuth] URL does not match expected callback format')
    }
  } catch (error) {
    console.error('[OAuth] Failed to parse callback URL:', error)
  }
})

// Fix PATH for GUI apps (async to avoid blocking startup)
function fixPlatformPath(): Promise<void> {
  if (process.platform === 'win32') {
    // On Windows, ensure common Node/npm/git paths are available
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const winPaths = [
      join(home, 'AppData', 'Roaming', 'npm'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files\\Git\\cmd'
    ]
    const existingPath = process.env.PATH || ''
    const missing = winPaths.filter(p => !existingPath.includes(p))
    if (missing.length > 0) {
      process.env.PATH = [...missing, existingPath].join(';')
    }
    return Promise.resolve()
  }
  if (process.platform !== 'darwin') return Promise.resolve()
  return new Promise((resolve) => {
    const userShell = process.env.SHELL || '/bin/zsh'
    execFile(userShell, ['-ilc', 'echo $PATH'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      if (!err && stdout && stdout.trim().length > 0) {
        console.log('[Main] Setting PATH from shell:', userShell)
        process.env.PATH = stdout.trim()
      } else {
        console.error('[Main] Failed to read shell PATH, using fallback')
        const commonPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.HOME + '/.nvm/versions/node/v22.14.0/bin']
        const existingPath = process.env.PATH || ''
        process.env.PATH = [...new Set([...commonPaths, ...existingPath.split(':')])].filter(Boolean).join(':')
      }
      resolve()
    })
  })
}

// Register app-attachment:// as a privileged scheme before app is ready.
// This allows the renderer to load local attachment images via <img src="app-attachment://...">.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-attachment',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
])

// Initialize crash logger as early as possible
initCrashLogger()

// Ignore EPIPE errors from broken stdout/stderr pipes (e.g. when piped through head/tail)
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err })
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err })

app.whenReady().then(async () => {
  // Register protocol handler: app-attachment://taskId/attachmentId
  // Serves local attachment files from the attachments directory.
  protocol.handle('app-attachment', (request) => {
    try {
      const url = new URL(request.url)
      // URL format: app-attachment://taskId/attachmentId
      const taskId = url.hostname
      const attachmentId = url.pathname.replace(/^\//, '')

      if (!taskId || !attachmentId || !db) {
        return new Response('Not found', { status: 404 })
      }

      const dir = join(app.getPath('userData'), 'attachments', taskId)
      const files = readdirSync(dir) // throws if dir missing — caught below
      const match = files.find((f) => f.startsWith(`${attachmentId}-`))
      if (!match) {
        return new Response('Not found', { status: 404 })
      }

      return net.fetch(pathToFileURL(join(dir, match)).href)
    } catch {
      return new Response('Internal error', { status: 500 })
    }
  })

  // Start PATH fix and DB init in parallel — both are independent
  const pathFixPromise = fixPlatformPath()

  db = new DatabaseManager()
  db.initialize()

  // Ensure PATH is ready before creating managers that may spawn child processes
  await pathFixPromise

  agentManager = new AgentManager(db)
  githubManager = new GitHubManager()
  worktreeManager = new WorktreeManager()
  agentManager.setManagers(githubManager, worktreeManager)

  mcpToolCaller = new McpToolCaller()

  oauthManager = new OAuthManager(db)

  // Wire OAuth manager into McpToolCaller and AgentManager for automatic token injection
  mcpToolCaller.setOAuthManager(oauthManager)
  agentManager.setOAuthManager(oauthManager)

  pluginRegistry = new PluginRegistry()
  pluginRegistry.register(new PeakfloPlugin())
  pluginRegistry.register(new LinearPlugin())
  pluginRegistry.register(new HubSpotPlugin())
  pluginRegistry.register(new GitHubIssuesPlugin(githubManager))
  pluginRegistry.register(new NotionPlugin())

  syncManager = new SyncManager(db, mcpToolCaller, pluginRegistry, oauthManager)
  agentManager.setSyncManager(syncManager)

  recurrenceScheduler = new RecurrenceScheduler(db)
  heartbeatScheduler = new HeartbeatScheduler(db, agentManager)

  // Initialize enterprise auth (gracefully — missing env vars just disable the feature)
  try {
    enterpriseAuth = new EnterpriseAuth(db)
  } catch (err) {
    console.warn('[Main] Enterprise auth initialization failed:', err)
  }

  claudePluginManager = new ClaudePluginManager(db)

  // Eagerly restore enterprise connection on startup so sync works immediately
  if (enterpriseAuth) {
    try {
      const session = await enterpriseAuth.getSession()
      console.log('[Main] Enterprise session on startup:', {
        isAuthenticated: session.isAuthenticated,
        userId: session.userId,
        hasTenant: !!session.currentTenant
      })
      if (session.isAuthenticated && session.currentTenant && session.userId) {
        const { WorkfloApiClient } = await import('./workflo-api-client')
        const { EnterpriseSyncManager } = await import('./enterprise-sync')

        const apiClient = new WorkfloApiClient(enterpriseAuth)
        const enterpriseSyncMgr = new EnterpriseSyncManager(db, apiClient)
        // Initialize and start enterprise heartbeat + state sync
        enterpriseHeartbeatInstance = new EnterpriseHeartbeat(apiClient)
        enterpriseHeartbeatInstance.start({
          userEmail: session.userEmail || undefined,
          userName: session.userEmail || undefined
        })

        enterpriseStateSyncInstance = new EnterpriseStateSync(apiClient)
        enterpriseStateSyncInstance.setUserName(session.userEmail || 'Unknown')

        // Attach state sync to heartbeat so events flush every 60s
        enterpriseHeartbeatInstance.setStateSync(enterpriseStateSyncInstance)

        // Wire state sync into agent manager so agent run events are recorded
        agentManager.setEnterpriseStateSync(enterpriseStateSyncInstance)

        syncManager.setEnterpriseConnection(apiClient, enterpriseSyncMgr, session.userId, enterpriseStateSyncInstance)

        console.log('[Main] Enterprise connection restored on startup (with heartbeat)')
      } else {
        console.log('[Main] Enterprise session not complete — skipping restore')
      }
    } catch (err) {
      console.warn('[Main] Could not restore enterprise connection on startup:', err)
    }
  } else {
    console.log('[Main] No enterprise auth instance — skipping restore')
  }

  registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry, mcpToolCaller, oauthManager, recurrenceScheduler, enterpriseAuth ?? undefined, claudePluginManager, heartbeatScheduler, enterpriseHeartbeatInstance ?? undefined, enterpriseStateSyncInstance ?? undefined)

  // Start secret broker and write shell wrapper (awaited so broker is ready before any sessions)
  try {
    const brokerPort = await startSecretBroker(db)
    console.log(`[Main] Secret broker started on port ${brokerPort}`)
    writeSecretShellWrapper()
  } catch (err) {
    console.error('[Main] Failed to start secret broker:', err)
  }

  // Start mobile API server
  try {
    agentManager.addExternalListener(broadcastToMobileClients)
    const mobilePort = await startMobileApiServer(db, agentManager, githubManager!, undefined, syncManager)
    console.log(`[Main] Mobile API server started on port ${mobilePort}`)
  } catch (err) {
    console.error('[Main] Failed to start mobile API server:', err)
  }

  // Check gh CLI status on startup (log only)
  githubManager.checkGhCli().then((status) => {
    console.log('[GitHub] CLI status:', status)
  }).catch(() => {})

  createWindow()

  // OpenCode server starts lazily on first agent session (avoids macOS permission
  // prompts for ~/Documents, ~/Downloads etc. on app launch).

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (isShuttingDown) {
    return
  }

  event.preventDefault()
  isShuttingDown = true
  isQuitting = true

  void shutdownAppServices().finally(() => {
    app.exit(0)
  })
})
