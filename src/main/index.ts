import { execFile, execSync } from 'child_process'
import { readdirSync } from 'fs'
import { app, BrowserWindow, net, protocol, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { DatabaseManager } from './database'
import { AgentManager } from './agent-manager'
import { GitHubManager } from './github-manager'
import { GitLabManager } from './gitlab-manager'
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
import { YouTrackPlugin } from './plugins/youtrack-plugin'
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
let gitlabManager: GitLabManager | null = null
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
    backgroundColor: '#1E2127',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#1E2127', symbolColor: '#535D71', height: 36 },
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

  // Strip embedding-restriction headers from ALL responses so external websites
  // can be embedded in iframes on the canvas. Must use { urls: ['*://*/*'] }
  // filter to ensure sub-frame requests are also intercepted.
  const BLOCKED_HEADERS_LC = [
    'x-frame-options',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
  ]

  mainWindow.webContents.session.webRequest.onHeadersReceived(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const responseHeaders: Record<string, string[]> = {}
      if (details.responseHeaders) {
        for (const [key, value] of Object.entries(details.responseHeaders)) {
          const lower = key.toLowerCase()
          // Skip blocked headers entirely
          if (BLOCKED_HEADERS_LC.includes(lower)) continue
          // Strip frame-ancestors from CSP
          if (lower === 'content-security-policy') {
            const cleaned = value.map((v) =>
              v.replace(/frame-ancestors\s+[^;]+(;|$)/gi, '').trim()
            ).filter(Boolean)
            if (cleaned.length > 0) responseHeaders[key] = cleaned
            continue
          }
          responseHeaders[key] = value
        }
      }
      callback({ cancel: false, responseHeaders })
    }
  )

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

// Load shell environment for GUI apps (async to avoid blocking startup)
// macOS GUI apps (launched from /Applications) do NOT inherit the user's shell
// environment, so CLI tools like codex, claude, gh etc. cannot be found and
// auth env vars like CODEX_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY are
// missing. We read the values from a login shell and apply them to process.env.
function loadPlatformShellEnv(): Promise<void> {
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

  // We need the interactive shell (`-i`) because tools like NVM, pnpm, bun,
  // etc. add their paths in `.zshrc` / `.bashrc` (interactive config), NOT in
  // `.zprofile` / `.bash_profile` (login-only config).
  //
  // Problem: interactive mode also causes shell init scripts (oh-my-zsh,
  // powerlevel10k, gitstatus, etc.) to emit escape codes, error messages,
  // and prompt strings that corrupt the output.
  //
  // Solution: use unique markers around the PATH value so we can reliably
  // extract it from the noisy output.
  const PATH_START = '__20X_PATH_START__'
  const PATH_END = '__20X_PATH_END__'
  const OPENAI_API_KEY_START = '__20X_OPENAI_API_KEY_START__'
  const OPENAI_API_KEY_END = '__20X_OPENAI_API_KEY_END__'
  const CODEX_API_KEY_START = '__20X_CODEX_API_KEY_START__'
  const CODEX_API_KEY_END = '__20X_CODEX_API_KEY_END__'
  const ANTHROPIC_API_KEY_START = '__20X_ANTHROPIC_API_KEY_START__'
  const ANTHROPIC_API_KEY_END = '__20X_ANTHROPIC_API_KEY_END__'

  const command = [
    `printf '%s%s%s\\n' "${PATH_START}" "$PATH" "${PATH_END}"`,
    `printf '%s%s%s\\n' "${OPENAI_API_KEY_START}" "$OPENAI_API_KEY" "${OPENAI_API_KEY_END}"`,
    `printf '%s%s%s\\n' "${CODEX_API_KEY_START}" "$CODEX_API_KEY" "${CODEX_API_KEY_END}"`,
    `printf '%s%s%s\\n' "${ANTHROPIC_API_KEY_START}" "$ANTHROPIC_API_KEY" "${ANTHROPIC_API_KEY_END}"`
  ].join('; ')

  const extractMarkedValue = (stdout: string, start: string, end: string): string | undefined => {
    const match = stdout.match(new RegExp(`${start}([\\s\\S]*?)${end}`))
    return match?.[1] || undefined
  }

  return new Promise((resolve) => {
    const userShell = process.env.SHELL || '/bin/zsh'
    execFile(
      userShell,
      ['-ilc', command],
      { timeout: 5000, encoding: 'utf8' },
      (err, stdout) => {
        if (!err && stdout) {
          const pathFromShell = extractMarkedValue(stdout, PATH_START, PATH_END)
          if (pathFromShell) {
            console.log('[Main] Setting PATH from shell:', userShell)
            process.env.PATH = pathFromShell
          } else {
            console.error('[Main] Failed to read shell PATH, using fallback')
            process.env.PATH = buildFallbackPath()
          }

          const openAiApiKey = extractMarkedValue(stdout, OPENAI_API_KEY_START, OPENAI_API_KEY_END)
          if (openAiApiKey) process.env.OPENAI_API_KEY = openAiApiKey

          const codexApiKey = extractMarkedValue(stdout, CODEX_API_KEY_START, CODEX_API_KEY_END)
          if (codexApiKey) process.env.CODEX_API_KEY = codexApiKey

          const anthropicApiKey = extractMarkedValue(stdout, ANTHROPIC_API_KEY_START, ANTHROPIC_API_KEY_END)
          if (anthropicApiKey) process.env.ANTHROPIC_API_KEY = anthropicApiKey

          resolve()
          return
        }

        console.error('[Main] Failed to read shell PATH, using fallback:', err?.message)
        process.env.PATH = buildFallbackPath()
        resolve()
      }
    )
  })
}

/**
 * Build a comprehensive fallback PATH when the shell invocation fails.
 * Covers Homebrew, system bins, npm/pnpm/volta globals, and NVM.
 */
function buildFallbackPath(): string {
  const home = process.env.HOME || ''
  const commonPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/Library/pnpm`,
    `${home}/.volta/bin`,
  ]

  // Dynamically detect NVM current version path instead of hardcoding
  if (home) {
    try {
      const nvmVersionsDir = join(home, '.nvm', 'versions', 'node')
      const versions = readdirSync(nvmVersionsDir) as string[]
      if (versions.length > 0) {
        // Sort descending to pick the latest installed version
        versions.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }))
        commonPaths.push(join(nvmVersionsDir, versions[0], 'bin'))
      }
    } catch {
      // NVM not installed — skip
    }
  }

  const existingPath = process.env.PATH || ''
  return [...new Set([...commonPaths, ...existingPath.split(':')])]
    .filter(Boolean)
    .join(':')
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
  const pathFixPromise = loadPlatformShellEnv()

  db = new DatabaseManager()
  db.initialize()

  // Ensure PATH is ready before creating managers that may spawn child processes
  await pathFixPromise

  agentManager = new AgentManager(db)
  githubManager = new GitHubManager()
  gitlabManager = new GitLabManager()
  worktreeManager = new WorktreeManager()
  agentManager.setManagers(githubManager, worktreeManager, gitlabManager ?? undefined)

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
  pluginRegistry.register(new YouTrackPlugin())

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
      console.log('[EnterpriseAuth] auth_session_restore_started')
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
        console.log('[EnterpriseAuth] auth_session_restore_result {"status":"restored"}')
      } else {
        console.log('[Main] Enterprise session not complete — skipping restore')
        console.log(
          `[EnterpriseAuth] auth_session_restore_result ${JSON.stringify({
            status: 'skipped',
            reason: 'missing_session_fields',
            hasUserId: !!session.userId,
            hasTenant: !!session.currentTenant,
            isAuthenticated: session.isAuthenticated
          })}`
        )
      }
    } catch (err) {
      console.warn('[Main] Could not restore enterprise connection on startup:', err)
      console.warn(
        `[EnterpriseAuth] auth_session_restore_result ${JSON.stringify({
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err)
        })}`
      )
    }
  } else {
    console.log('[Main] No enterprise auth instance — skipping restore')
    console.log('[EnterpriseAuth] auth_session_restore_result {"status":"skipped","reason":"enterprise_auth_not_initialized"}')
  }

  registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry, mcpToolCaller, oauthManager, recurrenceScheduler, enterpriseAuth ?? undefined, claudePluginManager, heartbeatScheduler, enterpriseHeartbeatInstance ?? undefined, enterpriseStateSyncInstance ?? undefined, gitlabManager ?? undefined)

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
    const mobilePort = await startMobileApiServer(db, agentManager, githubManager!, undefined, syncManager, pluginRegistry, gitlabManager)
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
