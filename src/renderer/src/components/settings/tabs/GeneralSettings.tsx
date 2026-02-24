import { useState, useEffect } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { settingsApi } from '@/lib/ipc-client'
import { Info, Bell, ExternalLink } from 'lucide-react'

export function GeneralSettings() {
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [loading, setLoading] = useState(true)
  const [testSent, setTestSent] = useState(false)

  const isMac = navigator.userAgent.includes('Mac')
  const isWindows = navigator.userAgent.includes('Win')

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Load launch at startup
        const loginSettings = await window.electronAPI?.app?.getLoginItemSettings()
        if (loginSettings) {
          setLaunchAtStartup(loginSettings.openAtLogin)
        }

        // Load notification setting from DB (not the broken Notification.isSupported check)
        const notifSetting = await settingsApi.get('notifications_enabled')
        // Default to enabled if never set
        setNotificationsEnabled(notifSetting !== 'false')

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
      setNotificationsEnabled(checked)
      await settingsApi.set('notifications_enabled', checked ? 'true' : 'false')
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

  const handleTestNotification = async () => {
    try {
      await window.electronAPI?.app?.sendTestNotification()
      setTestSent(true)
      setTimeout(() => setTestSent(false), 3000)
    } catch (error) {
      console.error('Failed to send test notification:', error)
    }
  }

  const handleOpenNotificationSettings = async () => {
    try {
      await window.electronAPI?.app?.openNotificationSettings()
    } catch (error) {
      console.error('Failed to open notification settings:', error)
    }
  }

  return (
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

        <div className="py-2 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="enable-notifications">Enable notifications</Label>
              <p className="text-xs text-muted-foreground">
                Show desktop notifications when agents finish tasks
              </p>
            </div>
            <Switch
              id="enable-notifications"
              checked={notificationsEnabled}
              onCheckedChange={handleNotificationsChange}
              disabled={loading}
            />
          </div>

          {notificationsEnabled && (
            <>
              {isMac && (
                <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5">
                  <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    On macOS, notifications require system permission. If you don&apos;t see
                    notifications, open System Settings and enable them for this app.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestNotification}
                  disabled={testSent}
                >
                  <Bell className="h-3.5 w-3.5" />
                  {testSent ? 'Sent!' : 'Send test notification'}
                </Button>

                {(isMac || isWindows) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenNotificationSettings}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open Notification Settings
                  </Button>
                )}
              </div>
            </>
          )}
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
  )
}
