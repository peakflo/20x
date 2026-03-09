import { useState, useEffect } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { settingsApi, mobileApi } from '@/lib/ipc-client'

export function GeneralSettings() {
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [mobileUrl, setMobileUrl] = useState('')
  const [loading, setLoading] = useState(true)

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
    </>
  )
}
