// Fix PATH for macOS GUI apps - must be first
import { execSync } from 'child_process'

// Manual PATH fix for macOS (fix-path package is ES module and can't be required)
if (process.platform === 'darwin') {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const shellPath = execSync(`${shell} -ilc 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 5000
    }).trim()

    if (shellPath && shellPath.length > 0) {
      console.log('[Main] Setting PATH from shell:', shell)
      process.env.PATH = shellPath
    }
  } catch (shellError) {
    console.error('[Main] Failed to read shell PATH, using fallback')
    // Add common paths as last resort
    const commonPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.HOME + '/.nvm/versions/node/v22.14.0/bin']
    const existingPath = process.env.PATH || ''
    process.env.PATH = [...new Set([...commonPaths, ...existingPath.split(':')])].filter(Boolean).join(':')
  }
}

import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { DatabaseManager } from './database'
import { AgentManager } from './agent-manager'
import { GitHubManager } from './github-manager'
import { WorktreeManager } from './worktree-manager'
import { McpToolCaller } from './mcp-tool-caller'
import { SyncManager } from './sync-manager'
import { OAuthManager } from './oauth-manager'
import { PluginRegistry } from './plugins/registry'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import { LinearPlugin } from './plugins/linear-plugin'
import { registerIpcHandlers } from './ipc-handlers'

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
      label: 'Show Workflo',
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

  tray.setToolTip('Workflo Workspace')
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

app.whenReady().then(async () => {
  db = new DatabaseManager()
  db.initialize()

  agentManager = new AgentManager(db)
  githubManager = new GitHubManager()
  worktreeManager = new WorktreeManager()

  mcpToolCaller = new McpToolCaller()

  oauthManager = new OAuthManager(db)

  pluginRegistry = new PluginRegistry()
  pluginRegistry.register(new PeakfloPlugin())
  pluginRegistry.register(new LinearPlugin())

  syncManager = new SyncManager(db, mcpToolCaller, pluginRegistry, oauthManager)

  registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry, mcpToolCaller, oauthManager)

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
  oauthManager?.destroy()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  // Ensure cleanup before quitting
  agentManager?.stopAllSessions()
  agentManager?.stopServer()
  mcpToolCaller?.destroy()
  oauthManager?.destroy()

  // Destroy tray
  if (tray) {
    tray.destroy()
    tray = null
  }
})
