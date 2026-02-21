import { useState, useEffect } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { settingsApi } from '@/lib/ipc-client'
import { useUpdateStore } from '@/stores/update-store'
import { RefreshCw } from 'lucide-react'

export function GeneralSettings() {
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [loading, setLoading] = useState(true)

  const { appVersion, status: updateStatus, checkForUpdates, loadAppVersion } = useUpdateStore()
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    loadAppVersion()
  }, [loadAppVersion])

  const handleCheckForUpdates = async () => {
    setChecking(true)
    await checkForUpdates()
    // Give a brief moment to show checking state
    setTimeout(() => setChecking(false), 2000)
  }

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
      title="About"
      description="Application version and update information"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2">
          <div className="space-y-0.5">
            <Label>Version</Label>
            <p className="text-xs text-muted-foreground">
              {appVersion ? `v${appVersion}` : 'Loading...'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckForUpdates}
            disabled={checking || updateStatus === 'checking'}
            className="h-8"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${checking || updateStatus === 'checking' ? 'animate-spin' : ''}`} />
            {checking || updateStatus === 'checking' ? 'Checking...' : 'Check for updates'}
          </Button>
        </div>
        {updateStatus === 'not-available' && !checking && (
          <p className="text-xs text-muted-foreground">You are on the latest version.</p>
        )}
        {updateStatus === 'available' && (
          <p className="text-xs text-primary">A new update is available! Check the banner above to download.</p>
        )}
        {updateStatus === 'downloaded' && (
          <p className="text-xs text-green-500">Update downloaded. Restart to apply.</p>
        )}
      </div>
    </SettingsSection>
    </>
  )
}
