import { execFile, execSync } from 'child_process'
import { readdirSync } from 'fs'
import { app, BrowserWindow, dialog, net, protocol, session, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { DatabaseManager, type TranscriptPartRecord } from './database'
import { AgentManager } from './agent-manager'
import { GitHubManager } from './github-manager'
import { GitLabManager } from './gitlab-manager'
import { WorktreeManager } from './worktree-manager'
import { McpToolCaller } from './mcp-tool-caller'
import { SyncManager } from './sync-manager'
import { OAuthManager } from './oauth/oauth-manager'
import { PluginRegistry } from './plugins/registry'
import { PeakfloPlugin } from './plugins/peakflo-plugin'
import { LinearPlugin } from './plugins/linear-plugin'
import { AsanaPlugin } from './plugins/asana-plugin'
import { HubSpotPlugin } from './plugins/hubspot-plugin'
import { GitHubIssuesPlugin } from './plugins/github-issues-plugin'
import { NotionPlugin } from './plugins/notion-plugin'
import { YouTrackPlugin } from './plugins/youtrack-plugin'
import { registerIpcHandlers } from './ipc-handlers'
import { panelBrowserBroker } from './panel-browser-broker'
import { VoiceSessionManager } from './voice/voice-session-manager'
import { assistantTextParts, sinceLastUserMessage } from './voice/voice-answer-parts'
import { EnterpriseAuth } from './enterprise-auth'
import { RecurrenceScheduler } from './recurrence-scheduler'
import { HeartbeatScheduler } from './heartbeat-scheduler'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import { ClaudePluginManager } from './claude-plugin-manager'
import { parseProcessTable, selectKillableMcpPids } from './mcp-process-cleanup'
import { buildWorkspaceStates, sweepLeakedWorkspaceProcesses, readDiskSpace, workspacePressureWarning, SHUTDOWN_GRACE_MS } from './workspace-process-cleanup'
import { WORKSPACES_DIR, listWorkspaceDirs } from './workspace-paths'
import { EnterpriseHeartbeat } from './enterprise-heartbeat'
import { EnterpriseStateSync } from './enterprise-state-sync'
import { handleRoute, setTaskApiAgentController, setTaskApiNotifier, setTaskApiUiState, setTaskAutomationTrigger, setTranscriptProvider, stopTaskApiServer } from './task-api-server'
import { startSecretBroker, stopSecretBroker, writeSecretShellWrapper } from './secret-broker'
import { startMcpAuthProxy, stopMcpAuthProxy } from './mcp-auth-proxy'
import { startMobileApiServer, stopMobileApiServer, broadcastToMobileClients, setMobileApiNotifier, setMobileApiTaskAutomationTrigger } from './mobile-api-server'
import { registerUpdaterIpc, initAutoUpdater, isUpdateDownloaded, getPendingVersion } from './auto-updater'
import { initCrashLogger } from './crash-logger'
import { installProcessStreamErrorHandlers } from './process-stream-errors'
import { getWindowsPathEntries, prependMissingWindowsPaths } from './windows-runtime-paths'
import { initAnalytics, shutdownAnalytics } from './analytics-service'

/**
 * Validate that a URL is safe to open via shell.openExternal.
 * Rejects about:blank, empty strings, and non-http(s)/mailto URLs
 * to avoid the macOS "no application set to open the URL" popup.
 */
function isExternalUrl(url: string): boolean {
  if (!url || url === 'about:blank' || url === 'about:srcdoc') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}

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
let taskAutomationScheduler: TaskAutomationScheduler | null = null
let workspaceCleanupScheduler: WorkspaceCleanupScheduler | null = null
let claudePluginManager: ClaudePluginManager | null = null
let enterpriseHeartbeatInstance: EnterpriseHeartbeat | null = null
let enterpriseStateSyncInstance: EnterpriseStateSync | null = null
let voiceSessionManager: VoiceSessionManager | null = null
let isShuttingDown = false

/**
 * Sends one voice event to the desktop renderer and to the mobile clients.
 * Voice actions reuse the normal task and agent events, so both clients stay in
 * step without a second state writer (design §5.11).
 */
function broadcastVoiceEvent(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
  broadcastToMobileClients(channel, data)
}

/**
 * Sends one voice event to the desktop window only.
 *
 * Spoken answers use this. The audio is produced on this computer and played by
 * this window; a phone cannot play a raw sample stream from the local
 * WebSocket, and sending it would push megabytes of samples through a text
 * channel for nothing (design §5.11).
 */
function sendVoiceEventToRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

/**
 * Reads an agent answer aloud as it is written (design §5.7).
 *
 * The answer arrives a few words at a time. Waiting for the agent to stop
 * before saying the first word would put the whole spoken answer behind the
 * agent — on a long answer, minutes behind — so the transcript is followed as
 * it changes and every finished sentence is read straight away.
 *
 * The `working -> idle` edge then closes the passage, and it is also the
 * fallback: an answer that produced no transcript event this session is read in
 * one piece from what was stored.
 *
 * This listener never decides to speak. It hands the passage to the speech
 * service, which speaks it only when the user asked for it by voice.
 */
function watchAgentAnswersForSpeech(agents: AgentManager, database: DatabaseManager): void {
  const lastStatus = new Map<string, string>()
  /** The newest assistant text of each task, as it is written. */
  const writing = new Map<string, true>()

  agents.addExternalListener((channel, data) => {
    try {
      if (channel === 'transcript:changed') {
        const event = data as { taskId?: string; parts?: TranscriptPartRecord[] }
        if (!event?.taskId || !event.parts?.length) return
        // Every message that changed, in order. A turn can hold several: the
        // agent says something, uses a tool, and says something else. Taking
        // only the newest skipped the first message entirely whenever both
        // landed in one flush.
        const parts = assistantTextParts(event.parts)
        if (parts.length === 0) return
        writing.set(event.taskId, true)
        void voiceSessionManager
          ?.streamAgentAnswer(event.taskId, parts)
          .catch((err) => console.error('[voice] reading the answer failed:', err))
        return
      }

      if (channel !== 'agent:status') return
      const event = data as { sessionId?: string; taskId?: string; status?: string }
      if (!event?.sessionId || !event.taskId || !event.status) return

      const previous = lastStatus.get(event.sessionId)
      if (event.status === 'idle') lastStatus.delete(event.sessionId)
      else lastStatus.set(event.sessionId, event.status)
      if (event.status !== 'idle' || previous !== 'working') return

      // Close the passage with the last words, which may have arrived after
      // the final transcript event. Only this turn's messages are considered:
      // everything the agent wrote since the user last spoke.
      const stored = database.getTranscriptParts(event.taskId)
      const all = assistantTextParts(sinceLastUserMessage(stored))
      // Whatever the user talked over is left out here too. Otherwise the
      // one-piece fallback below reads the whole interrupted answer at the
      // moment the agent stops.
      const parts = voiceSessionManager?.audibleAnswerParts(event.taskId, all) ?? all
      const open = writing.get(event.taskId)
      writing.delete(event.taskId)
      if (parts.length > 0 && voiceSessionManager?.finishAgentAnswer(event.taskId, parts)) {
        return
      }

      // Nothing was read as it was written — no transcript event reached us —
      // so the answer is read in one piece instead, every message of it.
      if (open) return
      const text = parts.map((part) => part.content).join('\n\n')
      if (!text.trim()) return
      void voiceSessionManager?.speakAgentAnswer(event.taskId, text).catch((err) => {
        console.error('[voice] speaking the answer failed:', err)
      })
    } catch (err) {
      // Speech must never disturb the agent stream.
      console.error('[voice] reading the answer failed:', err)
    }
  })
}

/**
 * Kills stdio MCP server processes that this instance leaked.
 *
 * Scoped to our own descendants and to processes that already lost their parent,
 * so a second 20x instance keeps the MCP children of its running agents. Called
 * at shutdown, and at startup to collect what a previous crash left behind.
 */
function sweepLeakedMcpProcesses(): void {
  try {
    if (process.platform === 'win32') {
      // No cheap ancestry query on Windows; keep the previous image-name filter.
      execSync('taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq task-management-mcp*"', { stdio: 'ignore' })
      return
    }

    const psOutput = execSync('ps -eo pid=,ppid=,command=', { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    const pids = selectKillableMcpPids(parseProcessTable(psOutput), process.pid)
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone between the listing and the signal.
      }
    }
    if (pids.length > 0) {
      console.log(`[Cleanup] Terminated ${pids.length} leaked MCP server process(es): ${pids.join(', ')}`)
    }
  } catch (err) {
    console.warn('[Cleanup] Could not sweep leaked MCP server processes:', err)
  }
}

/**
 * Kills processes still running inside a task workspace that nobody is driving.
 *
 * The same defect as the MCP sweep above, one level out: a watcher started by
 * `pnpm dev` inside a workspace survives its parents, is reparented to launchd,
 * and goes on watching several thousand files for days. Two such processes were
 * measured holding 43% of every open file descriptor on the owner's machine.
 *
 * Selection is by CWD AND TASK STATE, never by process name — `node`, `tsx` and
 * `next` are also how the user runs their own work, and a name match would kill
 * a dev server running in their own checkout.
 *
 * The boot call is the one that matters. These orphans reparent to launchd, so
 * a shutdown hook alone never sees a machine that was force-quit or rebooted.
 */
async function sweepLeakedWorkspaces(graceMs?: number, orphansIgnoreTaskState = false): Promise<void> {
  try {
    // A workspace with no task row is as leaked as a finished one, so the two
    // sources are paired rather than either alone. BOTH must be trustworthy: a
    // failed read of either one would classify healthy workspaces as leaked, so
    // each is checked and the sweep declines rather than guesses.
    const dirs = listWorkspaceDirs()
    if (dirs === null) {
      console.warn('[Cleanup] Skipping the workspace sweep: the workspaces directory could not be read.')
      return
    }
    const tasks = db ? db.getTasks().map((task) => ({ id: task.id, status: String(task.status) })) : []
    if (tasks.length === 0 && dirs.length > 0) {
      // Not credible: workspaces exist but the task table is empty. Far more
      // likely a closed or damaged database than a genuinely empty one — and
      // believing it would mark every workspace "no task for this workspace"
      // and kill everything in all of them.
      console.warn(`[Cleanup] Skipping the workspace sweep: ${dirs.length} workspaces on disk but no tasks in the database.`)
      return
    }
    const states = buildWorkspaceStates(tasks, dirs)
    await sweepLeakedWorkspaceProcesses({
      workspacesRoot: WORKSPACES_DIR,
      workspaceState: (workspaceId) => states.get(workspaceId) ?? { exists: false },
      graceMs,
      orphansIgnoreTaskState
    })

    // Nothing bounds the workspace count today. Report it with the free space
    // beside it, so the disk cost of one clone per agent run is visible before
    // it bites — the count alone does not say whether the next run will fit.
    const pressure = workspacePressureWarning({ count: dirs.length, disk: readDiskSpace(WORKSPACES_DIR) })
    if (pressure) console.warn(`[Cleanup] ${pressure}`)
  } catch (err) {
    console.warn('[Cleanup] Could not sweep leaked workspace processes:', err)
  }
}

async function shutdownAppServices(): Promise<void> {
  voiceSessionManager?.shutdown()
  enterpriseHeartbeatInstance?.stop()
  heartbeatScheduler?.stop()
  taskAutomationScheduler?.stop()
  workspaceCleanupScheduler?.stop()

  await agentManager?.stopAllSessions()
  await shutdownAnalytics()
  await agentManager?.stopServer()

  mcpToolCaller?.destroy()
  oauthManager?.destroy()
  stopSecretBroker()
  stopMcpAuthProxy()
  stopMobileApiServer()
  stopTaskApiServer()

  sweepLeakedMcpProcesses()
  // A short grace here: quitting must stay quick, and anything that ignores
  // SIGTERM is collected by the boot sweep on the next start.
  await sweepLeakedWorkspaces(SHUTDOWN_GRACE_MS)

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
    // Electron 44 native window-state persistence: remember position, size and
    // display mode across launches instead of always reopening at 1400x900.
    windowStatePersistence: true,
    name: 'main',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 8 } }
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
      sandbox: false,
      webviewTag: true,
      // Keep processing agent transcript IPC/timers while the window is
      // hidden or minimized — throttling a hidden renderer stalls streamed
      // updates and safety reconciles until the window is shown again.
      backgroundThrottling: false
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

    // Start task automation scheduler (auto-start / auto-complete reconciliation).
    // Deliberately window-independent: the flags must hold with no window open.
    taskAutomationScheduler?.start()

    // Start workspace cleanup scheduler
    if (workspaceCleanupScheduler && mainWindow) {
      workspaceCleanupScheduler.start(mainWindow)
    }

    // Periodic overdue check — nudges renderer every 60s
    setInterval(() => {
      mainWindow?.webContents.send('overdue:check')
    }, 60_000)
  })

  // Force the main window to 100% zoom on first load. Chromium persists page
  // zoom per host, so an accidental Cmd+- gets remembered — and because `pnpm dev`
  // loads from `localhost`, a stray zoom level stays applied on every dev launch
  // (the app opens zoomed out/in with no obvious way back). Reset once per launch;
  // in-session Cmd+/Cmd- still works. Embedded <webview> contents have their own
  // webContents and are unaffected.
  let didResetZoom = false
  mainWindow.webContents.on('did-finish-load', () => {
    if (didResetZoom) return
    didResetZoom = true
    mainWindow?.webContents.setZoomLevel(0)
  })

  // On Windows, `titleBarStyle: 'hidden'` + `titleBarOverlay` (Window Controls
  // Overlay) removes the native frame that would normally host the menu bar's
  // accelerator table — Menu.setApplicationMenu()'s Ctrl+/Ctrl-/Ctrl+0 roles
  // don't reliably fire in that mode. Handle the zoom shortcuts directly so
  // they work regardless of the (invisible) native menu.
  if (!isMac) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.meta || input.alt || input.shift) return
      const wc = mainWindow?.webContents
      if (!wc) return
      if (input.key === '=' || input.key === '+') {
        wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 9))
      } else if (input.key === '-') {
        wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -8))
      } else if (input.key === '0') {
        wc.setZoomLevel(0)
      }
    })
  }

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
    if (isExternalUrl(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // SAFETY: Prevent the main window from ever navigating away from the app.
  // Defense in depth for the panel browser broker: only registered canvas
  // browser panels are addressable by agents, so this should never fire —
  // but if anything ever drives the main window off-app, block it here.
  //
  // Layer 1: will-navigate (catches user-initiated navigations — NOT CDP)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigins = ['http://localhost:', 'file://']
    const isAppUrl = appOrigins.some((origin) => url.startsWith(origin))
    if (!isAppUrl) {
      console.warn(`[Main] Blocked navigation of main window to: ${url}`)
      event.preventDefault()
    }
  })

  // Layer 2: Recovery — snap the app back if the main window ever ends up on a
  // non-app URL despite the guard above. Safety net, not prevention.
  const appUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : null // file:// URL set after loadFile
  const mw = mainWindow // capture non-null reference for closure
  mw.webContents.on('did-navigate', (_event, url) => {
    const appOrigins = ['http://localhost:', 'file://']
    const isAppUrl = appOrigins.some((origin) => url.startsWith(origin))
    if (!isAppUrl) {
      console.warn(`[Main] Main window navigated to non-app URL: ${url} — recovering...`)
      if (appUrl) {
        mw.loadURL(appUrl)
      } else {
        mw.loadFile(join(__dirname, '../renderer/index.html'))
      }
    }
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
    // A closed window must not keep reporting the screen it last showed.
    setTaskApiUiState(null)
  })

  // Set main window for managers
  agentManager?.setMainWindow(mainWindow)
  worktreeManager?.setMainWindow(mainWindow)

  // Wire up task-api-server notifications to the renderer
  setTaskApiNotifier((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
    broadcastToMobileClients(channel, data)
  })

  // An MCP caller has no window, so the main-process loop is what honours the
  // auto-start / auto-complete flags it sets.
  setTaskAutomationTrigger(() => {
    void taskAutomationScheduler?.runNow()
  })
  setMobileApiTaskAutomationTrigger(() => {
    void taskAutomationScheduler?.runNow()
  })

  // Wire up transcript provider for subtask MCP agents to access sibling transcripts
  if (agentManager) {
    setTranscriptProvider((taskId) => agentManager!.getTranscriptForTask(taskId))
    setTaskApiAgentController(agentManager)
  }

  // Wire up mobile-api-server notifications to the renderer
  setMobileApiNotifier((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
  })
}

/**
 * Build and set the application menu.
 * Adds "Check for Updates…" under the app menu (macOS) or Help menu (Win/Linux).
 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      mainWindow?.show()
      mainWindow?.webContents.send('menu:check-for-updates')
    }
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              checkForUpdatesItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      label: 'Help',
      submenu: [
        ...(!isMac ? [checkForUpdatesItem, { type: 'separator' as const }] : []),
        {
          label: 'View on GitHub',
          click: () => {
            shell.openExternal('https://github.com/peakflo/20x')
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
    // On Windows, GUI apps can miss PATH updates from installers. Rehydrate the
    // usual runtime locations, including the python.org user install path used
    // by the NSIS bootstrap.
    process.env.PATH = prependMissingWindowsPaths(
      process.env.PATH || '',
      getWindowsPathEntries(process.env)
    )
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
  // CODEX_HOME: if the user's terminal `codex` uses a custom CODEX_HOME (e.g. a
  // work profile / a different ChatGPT account than ~/.codex), 20x must read the
  // SAME one — otherwise codex-acp authenticates as whatever account lives in the
  // default ~/.codex, which may be a free/over-limit account ("Upgrade to Plus")
  // while the terminal subscription works fine.
  const CODEX_HOME_START = '__20X_CODEX_HOME_START__'
  const CODEX_HOME_END = '__20X_CODEX_HOME_END__'

  const command = [
    `printf '%s%s%s\\n' "${PATH_START}" "$PATH" "${PATH_END}"`,
    `printf '%s%s%s\\n' "${OPENAI_API_KEY_START}" "$OPENAI_API_KEY" "${OPENAI_API_KEY_END}"`,
    `printf '%s%s%s\\n' "${CODEX_API_KEY_START}" "$CODEX_API_KEY" "${CODEX_API_KEY_END}"`,
    `printf '%s%s%s\\n' "${ANTHROPIC_API_KEY_START}" "$ANTHROPIC_API_KEY" "${ANTHROPIC_API_KEY_END}"`,
    `printf '%s%s%s\\n' "${CODEX_HOME_START}" "$CODEX_HOME" "${CODEX_HOME_END}"`
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

          // Inherit a custom CODEX_HOME so codex-acp authenticates as the SAME
          // ChatGPT account the user's terminal `codex` uses.
          const codexHome = extractMarkedValue(stdout, CODEX_HOME_START, CODEX_HOME_END)
          if (codexHome) {
            process.env.CODEX_HOME = codexHome
            console.log('[Main] Inherited CODEX_HOME from shell:', codexHome)
          }

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

// NOTE: The app intentionally does NOT expose a --remote-debugging-port.
// Canvas browser panels are driven by agents through the in-app panel browser
// broker (panel-browser-broker.ts) via browser_* MCP tools — only registered
// panels are addressable, so the main window can never be reached or
// navigated away by an agent. A global debug port would expose every target
// (main window = first page target) to any local process.

// ── Anti-bot-detection for embedded browser panels ─────────────────────────
// Some sites (Xero, banking portals) use Akamai's WAF which fingerprints
// the TLS ClientHello and HTTP/2 SETTINGS frames — baked into the compiled
// Electron binary and impossible to change at runtime.  We apply best-effort
// mitigations here; sites that still block are handled gracefully in the
// browser panel UI with an "Open in Chrome" fallback.

// 1. Replace user-agent with a real Chrome UA string.
const chromiumVersion = process.versions.chrome || '136.0.0.0'
const chromiumMajor = chromiumVersion.split('.')[0]
const cleanUA = process.platform === 'darwin'
  ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
  : process.platform === 'win32'
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
app.userAgentFallback = cleanUA

// 2. Disable AutomationControlled so navigator.webdriver = false when CDP is active.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// 3. Best-effort TLS/HTTP2 mitigations — these help with less aggressive WAFs
//    but cannot fully defeat Akamai's binary-level TLS fingerprinting.
app.commandLine.appendSwitch('enable-features', [
  'PermuteTLSExtensions',          // randomise TLS extension order
  'PostQuantumKyber',              // Chrome enables this by default
].join(','))
app.commandLine.appendSwitch('disable-features', [
  'AcceptCHFrame',                 // Electron-only ALPS extension not in Chrome
].join(','))

installProcessStreamErrorHandlers()

app.whenReady().then(async () => {
  const analytics = initAnalytics()

  // Collect MCP server processes that a previous crash or force-quit orphaned.
  // Safe for a second live instance: only parentless processes match here,
  // because this instance has no descendants yet.
  sweepLeakedMcpProcesses()
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

  // The BOOT sweep for workspace processes. It runs here rather than beside the
  // MCP sweep above because it needs the task table to tell a leaked workspace
  // from one an agent is working in. This is the call that catches a machine
  // that was force-quit or rebooted: those orphans reparent to launchd, so no
  // shutdown hook ever sees them. Awaited — on a machine that has hit EMFILE
  // the descriptors must come back before this instance opens its own.
  // `orphansIgnoreTaskState` is true HERE AND ONLY HERE. Task status is
  // deliberately preserved across a quit and nothing repairs it at startup, so
  // a force-quit task stays `agent_working` forever — and without this the
  // watcher it leaked would be vetoed by its own stale status on every boot,
  // making the reported case the one case that could never be collected.
  await sweepLeakedWorkspaces(undefined, true)
  analytics.record('server.boot.heartbeat', {
    taskCount: db.getTasks().length,
    agentCount: db.getAgents().length
  })

  // Ensure PATH is ready before creating managers that may spawn child processes
  await pathFixPromise

  agentManager = new AgentManager(db)
  githubManager = new GitHubManager()
  gitlabManager = new GitLabManager()
  worktreeManager = new WorktreeManager()
  agentManager.setManagers(githubManager, worktreeManager, gitlabManager ?? undefined)

  mcpToolCaller = new McpToolCaller()
  // Run task-management tools in this process instead of spawning a child that
  // would only forward them back here.
  mcpToolCaller.setTaskManagementInvoker((route, params) => handleRoute(db!, route, params))

  oauthManager = new OAuthManager(db)

  // Wire OAuth manager into McpToolCaller and AgentManager for automatic token injection
  mcpToolCaller.setOAuthManager(oauthManager)
  agentManager.setOAuthManager(oauthManager)

  pluginRegistry = new PluginRegistry()
  pluginRegistry.register(new PeakfloPlugin())
  pluginRegistry.register(new LinearPlugin())
  pluginRegistry.register(new AsanaPlugin())
  pluginRegistry.register(new HubSpotPlugin())
  pluginRegistry.register(new GitHubIssuesPlugin(githubManager))
  pluginRegistry.register(new NotionPlugin())
  pluginRegistry.register(new YouTrackPlugin())

  syncManager = new SyncManager(db, mcpToolCaller, pluginRegistry, oauthManager)
  agentManager.setSyncManager(syncManager)

  recurrenceScheduler = new RecurrenceScheduler(db)
  heartbeatScheduler = new HeartbeatScheduler(db, agentManager)
  taskAutomationScheduler = new TaskAutomationScheduler(db, agentManager)
  // A brand-new recurring instance must not wait up to a minute to start.
  recurrenceScheduler.setOnInstancesCreated(() => {
    void taskAutomationScheduler?.runNow()
  })
  workspaceCleanupScheduler = new WorkspaceCleanupScheduler(db, worktreeManager)

  // Initialize enterprise auth (gracefully — missing env vars just disable the feature)
  try {
    enterpriseAuth = new EnterpriseAuth(db)
  } catch (err) {
    console.warn('[Main] Enterprise auth initialization failed:', err)
  }

  claudePluginManager = new ClaudePluginManager(db)

  // Voice control (design §5.1). It never blocks start-up: when the local
  // speech runtime or the model is absent, voice simply stays switched off.
  voiceSessionManager = new VoiceSessionManager({
    db,
    agents: agentManager,
    notify: broadcastVoiceEvent,
    notifyRenderer: sendVoiceEventToRenderer
  })
  void voiceSessionManager.initialize()
  watchAgentAnswersForSpeech(agentManager, db)

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

        // Wire enterprise auth into agent manager so it can inject JWT into MCP Dev Server requests
        agentManager.setEnterpriseAuth(enterpriseAuth)

        // Start MCP auth proxy so agent sessions get auto-refreshing JWT
        // on every MCP tool call (ACP/OpenCode/Claude Code never refresh
        // MCP headers mid-session — the proxy solves this transparently).
        try {
          const proxyPort = await startMcpAuthProxy(enterpriseAuth)
          console.log(`[Main] MCP auth proxy started on port ${proxyPort}`)
        } catch (proxyErr) {
          console.warn('[Main] MCP auth proxy failed to start (MCP JWT will use static headers):', proxyErr)
        }

        syncManager.setEnterpriseConnection(apiClient, enterpriseSyncMgr, session.userId, enterpriseStateSyncInstance)

        // Eagerly refresh AI gateway virtual key so the Peakflo provider is
        // available in the DB before the OpenCode adapter starts its server.
        // Handles plans activated after the initial tenant selection.
        try {
          await enterpriseAuth.refreshAiGatewayVirtualKey()
        } catch (err) {
          console.warn('[Main] AI gateway key refresh on startup failed (non-fatal):', err)
        }

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

  registerIpcHandlers(db, agentManager, githubManager, worktreeManager, syncManager, pluginRegistry, mcpToolCaller, oauthManager, recurrenceScheduler, enterpriseAuth ?? undefined, claudePluginManager, heartbeatScheduler, enterpriseHeartbeatInstance ?? undefined, enterpriseStateSyncInstance ?? undefined, gitlabManager ?? undefined, workspaceCleanupScheduler ?? undefined, voiceSessionManager ?? undefined, taskAutomationScheduler ?? undefined)

  // ── Media permission handler (design §5.9) ────────────────────────────────
  // Grant the microphone only to the 20x renderer, and only while voice is on.
  // Every other media request (camera, screen, and any embedded web content) is
  // refused. This is the single permission handler for the default session.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') {
      // Everything else keeps the behaviour this app had before the handler
      // existed, so no embedded content loses a permission it already used.
      callback(true)
      return
    }
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    if (mediaTypes.includes('video')) {
      callback(false)
      return
    }
    const isAppWindow = mainWindow != null && contents === mainWindow.webContents
    callback(isAppWindow && voiceSessionManager?.isEnabled() === true)
  })

  // Register updater IPC handlers (safe in dev mode — returns no-op results)
  registerUpdaterIpc()

  // Build the application menu (includes "Check for Updates…")
  buildAppMenu()

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

  // ── Strip embedding-restriction headers ───────────────────────────────────
  // Register on session.defaultSession so it intercepts ALL HTTP responses
  // including those from iframes/subframes. Must be set before any window loads.
  const BLOCKED_HEADERS_LC = [
    'x-frame-options',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
  ]

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders }
      if (headers) {
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase()
          if (BLOCKED_HEADERS_LC.includes(lower)) {
            delete headers[key]
            continue
          }
          // Strip frame-ancestors from CSP
          if (lower === 'content-security-policy') {
            const values = headers[key]
            if (Array.isArray(values)) {
              headers[key] = values.map((v) =>
                v.replace(/frame-ancestors\s+[^;]+(;|$)/gi, '').trim()
              ).filter(Boolean)
              if (headers[key]!.length === 0) delete headers[key]
            }
          }
        }
      }
      callback({ cancel: false, responseHeaders: headers })
    }
  )

  // ── Patch Sec-CH-UA on all outgoing requests ──────────────────────────────
  // Electron's Sec-CH-UA omits the "Google Chrome" brand, which Akamai uses
  // as a signal.  We intercept via will-attach-webview to configure each
  // webview's session without conflicting with enterprise auth handlers.
  //
  // We modify the defaultSession headers directly.  The onBeforeSendHeaders
  // handler merges with enterprise auth because enterprise auth only registers
  // its handler AFTER enableIframeAuth is called (and with a narrow URL filter).
  // Our handler runs first; if enterprise auth later overrides it with its
  // scoped filter, that's fine — the scoped handler only affects API URLs.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }

      // Rewrite Sec-CH-UA to include "Google Chrome" brand like real Chrome
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (lower === 'sec-ch-ua') {
          headers[key] = `"Chromium";v="${chromiumMajor}", "Google Chrome";v="${chromiumMajor}", "Not_A Brand";v="24"`
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[key] = `"Chromium";v="${chromiumVersion}", "Google Chrome";v="${chromiumVersion}", "Not_A Brand";v="24.0.0.0"`
        }
      }

      // If Sec-CH-UA wasn't present at all, add it
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'sec-ch-ua')) {
        headers['Sec-CH-UA'] = `"Chromium";v="${chromiumMajor}", "Google Chrome";v="${chromiumMajor}", "Not_A Brand";v="24"`
      }

      callback({ requestHeaders: headers })
    }
  )

  // Inject anti-bot JS patches into webview pages (handles client-side
  // fingerprinting that Akamai runs after the page loads).
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      // Intercept window.open calls from webviews — open valid URLs externally,
      // silently ignore about:blank and other invalid URLs to prevent the macOS
      // "no application set to open the URL" popup.
      contents.setWindowOpenHandler((details) => {
        if (isExternalUrl(details.url)) {
          shell.openExternal(details.url)
        }
        return { action: 'deny' }
      })

      contents.on('dom-ready', () => {
        contents.executeJavaScript(`
          try {
            Object.defineProperty(navigator, 'webdriver', {
              get: () => false, configurable: true,
            });
          } catch(e) {}
          try {
            if (!window.chrome) { window.chrome = {}; }
            if (!window.chrome.runtime) {
              window.chrome.runtime = { id: undefined };
            }
          } catch(e) {}
          try {
            Object.defineProperty(navigator, 'plugins', {
              get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
              ],
              configurable: true,
            });
          } catch(e) {}
          try {
            Object.defineProperty(navigator, 'languages', {
              get: () => ['en-US', 'en'], configurable: true,
            });
          } catch(e) {}
        `).catch(() => {})
      })
    }
  })

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

app.on('before-quit', async (event) => {
  if (isShuttingDown) {
    return
  }

  panelBrowserBroker.stopAll()

  event.preventDefault()

  // If a downloaded update is ready, offer to install before quitting
  if (isUpdateDownloaded()) {
    const version = getPendingVersion()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `A new version${version ? ` (v${version})` : ''} has been downloaded.`,
      detail: 'Would you like to install the update and restart, or quit without updating?',
      buttons: ['Install & Restart', 'Quit Without Updating'],
      defaultId: 0,
      cancelId: 1
    })

    if (response === 0) {
      // Install & restart — set flag first to prevent before-quit loop
      isShuttingDown = true
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.quitAndInstall()
      return
    }
  }

  isShuttingDown = true
  isQuitting = true

  void shutdownAppServices().finally(() => {
    app.exit(0)
  })
})
