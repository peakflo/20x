import { useState, useEffect } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { settingsApi, mobileApi } from '@/lib/ipc-client'
import { useUpdateStore } from '@/stores/update-store'
import { useUIStore } from '@/stores/ui-store'
import { Loader2 } from 'lucide-react'

export function GeneralSettings() {
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [mobileUrl, setMobileUrl] = useState('')
  const [loading, setLoading] = useState(true)

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

    <UpdateSection />
    </>
  )
}

function UpdateSection() {
  const { updateAvailable, isChecking, isUpToDate, currentVersion, checkForUpdates } = useUpdateStore()
  const { openUpdateDialog } = useUIStore()

  return (
    <SettingsSection
      title="Updates"
      description="Check for new versions of 20x"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2">
          <div className="space-y-0.5">
            <Label>App version</Label>
            <p className="text-xs text-muted-foreground">
              {currentVersion ? `v${currentVersion}` : 'Loading...'}
              {updateAvailable && (
                <span className="ml-2 text-amber-400 font-medium">
                  v{updateAvailable.version} available
                </span>
              )}
              {isUpToDate && !updateAvailable && (
                <span className="ml-2 text-green-400 font-medium">
                  Up to date
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {updateAvailable && (
              <Button size="sm" variant="outline" onClick={openUpdateDialog}>
                View Update
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={checkForUpdates}
              disabled={isChecking}
            >
              {isChecking && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
              Check for Updates
            </Button>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
