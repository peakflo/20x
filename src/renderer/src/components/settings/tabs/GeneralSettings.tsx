import { useState, useEffect } from 'react'
import { Wrench, RefreshCw, Download, Check, Loader2, Trash2 } from 'lucide-react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { ToolSetupDialog } from '@/components/AgentSetupWizard'
import { settingsApi, mobileApi, updaterApi, worktreeApi, onWorkspaceCleanupProgress } from '@/lib/ipc-client'

export function GeneralSettings() {
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [mobileUrl, setMobileUrl] = useState('')
  const [loading, setLoading] = useState(true)

  // Updater state
  const [updateStatus, setUpdateStatus] = useState<string>('idle')
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updatePercent, setUpdatePercent] = useState(0)
  const [updateError, setUpdateError] = useState<string | null>(null)

  useEffect(() => {
    const cleanup = updaterApi.onStatus((data) => {
      setUpdateStatus(data.status)
      if (data.version) setUpdateVersion(data.version)
      if (data.percent !== undefined) setUpdatePercent(data.percent)
      if (data.error) setUpdateError(data.error)
    })
    return cleanup
  }, [])

  // Workspace cleanup progress listener
  useEffect(() => {
    const cleanup = onWorkspaceCleanupProgress((event) => {
      if (event.phase === 'done') {
        setCleanupRunning(false)
        setCleanupProgress(null)
        if (event.cleaned !== undefined && event.cleaned > 0) {
          setCleanupResult(`Cleaned ${event.cleaned} workspace${event.cleaned !== 1 ? 's' : ''}`)
        } else if (event.errors && event.errors.length > 0) {
          setCleanupResult(`Cleanup finished with ${event.errors.length} error${event.errors.length !== 1 ? 's' : ''}`)
        } else {
          setCleanupResult('No workspaces to clean')
        }
      } else {
        setCleanupRunning(true)
        setCleanupProgress({ current: event.current, total: event.total, message: event.message })
      }
    })
    return cleanup
  }, [])

  // Workspace cleanup settings
  const [autocleanEnabled, setAutocleanEnabled] = useState(false)
  const [autocleanDays, setAutocleanDays] = useState('7')
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<string | null>(null)
  const [cleanupProgress, setCleanupProgress] = useState<{ current: number; total: number; message?: string } | null>(null)

  // Heartbeat settings
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(true)
  const [heartbeatInterval, setHeartbeatInterval] = useState('30')
  const [heartbeatActiveStart, setHeartbeatActiveStart] = useState('')
  const [heartbeatActiveEnd, setHeartbeatActiveEnd] = useState('')
  const [heartbeatGlobalInstructions, setHeartbeatGlobalInstructions] = useState('')

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Load launch at startup
        const loginSettings = await window.electronAPI?.app?.getLoginItemSettings()
        if (loginSettings) {
          setLaunchAtStartup(loginSettings.openAtLogin)
        }

        // Load notification permission
        const notifPerm = await window.electronAPI?.app?.getNotificationPermission()
        setNotificationsEnabled(notifPerm === 'granted')

        // Load minimize to tray
        const tray = await window.electronAPI?.app?.getMinimizeToTray()
        setMinimizeToTray(tray || false)
      } catch (error) {
        console.error('Failed to load app preferences:', error)
      } finally {
        setLoading(false)
      }

      // Load workspace cleanup settings
      try {
        const cleanupEnabled = await settingsApi.get('workspace_autocleanup_enabled')
        if (cleanupEnabled !== null) setAutocleanEnabled(cleanupEnabled === 'true')

        const cleanupDays = await settingsApi.get('workspace_autocleanup_days')
        if (cleanupDays) setAutocleanDays(cleanupDays)
      } catch (error) {
        console.error('Failed to load workspace cleanup settings:', error)
      }

      // Load heartbeat settings
      try {
        const hbEnabled = await settingsApi.get('heartbeat_enabled_global')
        if (hbEnabled !== null) setHeartbeatEnabled(hbEnabled !== 'false')

        const hbInterval = await settingsApi.get('heartbeat_default_interval')
        if (hbInterval) setHeartbeatInterval(hbInterval)

        const hbStart = await settingsApi.get('heartbeat_active_hours_start')
        if (hbStart) setHeartbeatActiveStart(hbStart)

        const hbEnd = await settingsApi.get('heartbeat_active_hours_end')
        if (hbEnd) setHeartbeatActiveEnd(hbEnd)

        const hbGlobal = await settingsApi.get('heartbeat_global_instructions')
        if (hbGlobal) setHeartbeatGlobalInstructions(hbGlobal)
      } catch (error) {
        console.error('Failed to load heartbeat settings:', error)
      }

      // Load mobile URL separately so its failure doesn't block other settings
      try {
        const info = await mobileApi.getInfo()
        setMobileUrl(info.url)
      } catch (error) {
        console.error('Failed to load mobile URL:', error)
        setMobileUrl('')
      }
    }
    loadSettings()
  }, [])

  const handleLaunchAtStartupChange = async (checked: boolean) => {
    try {
      await window.electronAPI?.app?.setLoginItemSettings(checked)
      setLaunchAtStartup(checked)
    } catch (error) {
      console.error('Failed to update launch at startup:', error)
    }
  }

  const handleNotificationsChange = async (checked: boolean) => {
    try {
      if (checked) {
        const permission = await window.electronAPI?.app?.requestNotificationPermission()
        setNotificationsEnabled(permission === 'granted')
        await settingsApi.set('notifications_enabled', permission === 'granted' ? 'true' : 'false')
      } else {
        setNotificationsEnabled(false)
        await settingsApi.set('notifications_enabled', 'false')
      }
    } catch (error) {
      console.error('Failed to update notifications:', error)
    }
  }

  const handleMinimizeToTrayChange = async (checked: boolean) => {
    try {
      await window.electronAPI?.app?.setMinimizeToTray(checked)
      setMinimizeToTray(checked)
    } catch (error) {
      console.error('Failed to update minimize to tray:', error)
    }
  }

  return (
    <>
    <SettingsSection
      title="Application Preferences"
      description="Configure general application behavior and preferences"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="launch-startup">Launch at startup</Label>
            <p className="text-xs text-muted-foreground">
              Automatically launch the app when you log in
            </p>
          </div>
          <Switch
            id="launch-startup"
            checked={launchAtStartup}
            onCheckedChange={handleLaunchAtStartupChange}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="enable-notifications">Enable notifications</Label>
            <p className="text-xs text-muted-foreground">
              Show desktop notifications for task updates
            </p>
          </div>
          <Switch
            id="enable-notifications"
            checked={notificationsEnabled}
            onCheckedChange={handleNotificationsChange}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="minimize-tray">Minimize to tray</Label>
            <p className="text-xs text-muted-foreground">
              Keep app running in system tray when closed
            </p>
          </div>
          <Switch
            id="minimize-tray"
            checked={minimizeToTray}
            onCheckedChange={handleMinimizeToTrayChange}
            disabled={loading}
          />
        </div>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Mobile Web"
      description="Access 20x from your phone or tablet on the same network"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label>Address</Label>
            <p className="text-xs text-muted-foreground">
              Open this URL on any device connected to the same Wi-Fi
            </p>
          </div>
          {mobileUrl ? (
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono bg-accent/50 rounded px-2.5 py-1 text-foreground select-all">
                {mobileUrl}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(mobileUrl)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="Copy URL"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                </svg>
              </button>
            </div>
          ) : loading ? (
            <span className="text-sm text-muted-foreground">Loading...</span>
          ) : (
            <span className="text-sm text-muted-foreground">Unavailable</span>
          )}
        </div>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Workspace Auto-Cleanup"
      description="Automatically clean up workspace files for completed tasks after a configurable retention period"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="autoclean-enabled">Enable auto-cleanup</Label>
            <p className="text-xs text-muted-foreground">
              Automatically remove workspace files for tasks completed more than the configured number of days ago
            </p>
          </div>
          <Switch
            id="autoclean-enabled"
            checked={autocleanEnabled}
            onCheckedChange={async (checked) => {
              setAutocleanEnabled(checked)
              await settingsApi.set('workspace_autocleanup_enabled', checked ? 'true' : 'false')
            }}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="autoclean-days">Retention period</Label>
            <p className="text-xs text-muted-foreground">
              Days to keep workspace files after task completion
            </p>
          </div>
          <select
            id="autoclean-days"
            value={autocleanDays}
            onChange={async (e) => {
              setAutocleanDays(e.target.value)
              await settingsApi.set('workspace_autocleanup_days', e.target.value)
            }}
            disabled={loading || !autocleanEnabled}
            className="bg-transparent border rounded px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value="1">1 day</option>
            <option value="3">3 days</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
          </select>
        </div>

        <div className="py-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Manual cleanup</Label>
              <p className="text-xs text-muted-foreground">
                Run workspace cleanup now for all eligible completed tasks
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!cleanupRunning && cleanupResult && (
                <span className="text-xs text-muted-foreground">{cleanupResult}</span>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={cleanupRunning}
                onClick={async () => {
                  setCleanupRunning(true)
                  setCleanupResult(null)
                  setCleanupProgress(null)
                  try {
                    const result = await worktreeApi.runCleanupNow()
                    // The progress listener handles the final state via the 'done' event,
                    // but also handle the IPC response as a fallback
                    if (!cleanupProgress) {
                      if (result.cleaned > 0) {
                        setCleanupResult(`Cleaned ${result.cleaned} workspace${result.cleaned !== 1 ? 's' : ''}`)
                      } else if (result.errors.length > 0 && result.errors[0] === 'Cleanup is already in progress') {
                        setCleanupResult('Cleanup already in progress')
                      } else {
                        setCleanupResult('No workspaces to clean')
                      }
                      setCleanupRunning(false)
                    }
                  } catch (error) {
                    setCleanupResult('Cleanup failed')
                    setCleanupRunning(false)
                    console.error('Workspace cleanup error:', error)
                  }
                }}
              >
                {cleanupRunning ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5 mr-1.5" />
                )}
                {cleanupRunning ? 'Cleaning...' : 'Clean Now'}
              </Button>
            </div>
          </div>

          {/* Progress bar */}
          {cleanupRunning && cleanupProgress && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{cleanupProgress.message || 'Preparing...'}</span>
                {cleanupProgress.total > 0 && (
                  <span>{cleanupProgress.current}/{cleanupProgress.total}</span>
                )}
              </div>
              <div className="h-1.5 w-full bg-accent/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{
                    width: cleanupProgress.total > 0
                      ? `${Math.round((cleanupProgress.current / cleanupProgress.total) * 100)}%`
                      : '0%'
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Heartbeat Monitoring"
      description="Periodic checks on tasks in review — monitors PRs, issues, and deployments"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="heartbeat-enabled">Enable heartbeat</Label>
            <p className="text-xs text-muted-foreground">
              Periodically check tasks with heartbeat.md files for updates
            </p>
          </div>
          <Switch
            id="heartbeat-enabled"
            checked={heartbeatEnabled}
            onCheckedChange={async (checked) => {
              setHeartbeatEnabled(checked)
              await settingsApi.set('heartbeat_enabled_global', checked ? 'true' : 'false')
            }}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="heartbeat-interval">Default interval</Label>
            <p className="text-xs text-muted-foreground">
              How often to check each task (can be overridden per-task)
            </p>
          </div>
          <select
            id="heartbeat-interval"
            value={heartbeatInterval}
            onChange={async (e) => {
              setHeartbeatInterval(e.target.value)
              await settingsApi.set('heartbeat_default_interval', e.target.value)
            }}
            disabled={loading || !heartbeatEnabled}
            className="bg-transparent border rounded px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">4 hours</option>
          </select>
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label>Active hours</Label>
            <p className="text-xs text-muted-foreground">
              Only run heartbeat checks during these hours (leave empty for always)
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <input
              type="time"
              value={heartbeatActiveStart}
              onChange={async (e) => {
                setHeartbeatActiveStart(e.target.value)
                await settingsApi.set('heartbeat_active_hours_start', e.target.value)
              }}
              disabled={loading || !heartbeatEnabled}
              className="bg-transparent border rounded px-2 py-1 text-sm disabled:opacity-50"
              placeholder="09:00"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="time"
              value={heartbeatActiveEnd}
              onChange={async (e) => {
                setHeartbeatActiveEnd(e.target.value)
                await settingsApi.set('heartbeat_active_hours_end', e.target.value)
              }}
              disabled={loading || !heartbeatEnabled}
              className="bg-transparent border rounded px-2 py-1 text-sm disabled:opacity-50"
              placeholder="22:00"
            />
          </div>
        </div>

        <div className="py-2">
          <div className="space-y-1.5 mb-2">
            <Label htmlFor="heartbeat-global-instructions">Global instructions</Label>
            <p className="text-xs text-muted-foreground">
              Default instructions prepended to every heartbeat check. Per-task heartbeat.md takes priority.
            </p>
          </div>
          <textarea
            id="heartbeat-global-instructions"
            value={heartbeatGlobalInstructions}
            onChange={(e) => setHeartbeatGlobalInstructions(e.target.value)}
            onBlur={async () => {
              await settingsApi.set('heartbeat_global_instructions', heartbeatGlobalInstructions)
            }}
            disabled={loading || !heartbeatEnabled}
            rows={6}
            className="w-full bg-transparent border rounded px-3 py-2 text-sm font-mono disabled:opacity-50 resize-y placeholder:text-muted-foreground"
            placeholder="e.g. Always run `gh api` calls to verify status. Never skip checks. Reply HEARTBEAT_OK only when everything is clean."
          />
        </div>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Updates"
      description="Check for new versions and install updates"
    >
      <div className="flex items-center gap-3">
        {updateStatus === 'idle' || updateStatus === 'up-to-date' || updateStatus === 'error' ? (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              setUpdateError(null)
              setUpdateStatus('checking')
              await updaterApi.check()
            }}
          >
            <RefreshCw className="size-3.5 mr-1.5" />
            Check for Updates
          </Button>
        ) : updateStatus === 'checking' ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            Checking...
          </Button>
        ) : updateStatus === 'available' ? (
          <Button
            size="sm"
            onClick={async () => {
              await updaterApi.download()
            }}
          >
            <Download className="size-3.5 mr-1.5" />
            Download v{updateVersion}
          </Button>
        ) : updateStatus === 'downloading' ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            Downloading... {updatePercent}%
          </Button>
        ) : updateStatus === 'downloaded' ? (
          <Button
            size="sm"
            onClick={() => updaterApi.install()}
          >
            <Check className="size-3.5 mr-1.5" />
            Install & Restart (v{updateVersion})
          </Button>
        ) : null}

        {updateStatus === 'up-to-date' && (
          <span className="text-xs text-emerald-400 flex items-center gap-1.5">
            <Check className="size-3.5" />
            You&apos;re on the latest version
          </span>
        )}

        {updateError && (
          <span className="text-xs text-red-400">{updateError}</span>
        )}
      </div>
    </SettingsSection>

    <SettingsSection
      title="Agent & Tool Setup"
      description="Detect installed CLI tools and install missing ones"
    >
      <Button
        variant="outline"
        onClick={() => setSetupDialogOpen(true)}
      >
        <Wrench className="size-4 mr-1.5" />
        Open Setup Wizard
      </Button>
      <ToolSetupDialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen} />
    </SettingsSection>
    </>
  )
}
