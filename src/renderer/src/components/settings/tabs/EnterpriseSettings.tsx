import { useState, useEffect, useCallback } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { usePresetupStore } from '@/stores/presetup-store'
import type { PresetupTemplate } from '@/lib/presetup-api'
import { PresetupFlow } from '@/components/presetup/PresetupFlow'
import { PresetList } from '@/components/presetup/PresetList'
import { EnterpriseLoginModal } from './EnterpriseLoginModal'

// ── Main component ──────────────────────────────────────────────────
export function EnterpriseSettings() {
  const {
    isAuthenticated,
    isLoading,
    userEmail,
    currentTenant,
    logout,
    loadSession
  } = useEnterpriseStore()

  const [showLoginModal, setShowLoginModal] = useState(false)
  const [presetupOpen, setPresetupOpen] = useState(false)
  const [presetupKey, setPresetupKey] = useState(0) // force re-mount after install

  useEffect(() => {
    loadSession()
  }, [loadSession])

  const handleLogout = useCallback(async () => {
    await logout()
  }, [logout])

  const handleSwitchOrg = useCallback(() => {
    useEnterpriseStore.setState({
      isAuthenticated: false,
      currentTenant: null,
      availableTenants: null
    })
    logout().then(() => setShowLoginModal(true))
  }, [logout])

  const handleSelectTemplate = useCallback((template: PresetupTemplate) => {
    // Pre-select the template and open the flow
    usePresetupStore.getState().reset()
    usePresetupStore.getState().selectTemplate(template)
    setPresetupOpen(true)
  }, [])

  const handlePresetupClose = useCallback((open: boolean) => {
    setPresetupOpen(open)
    if (!open) {
      usePresetupStore.getState().reset()
      // Bump key to refresh the list (picks up newly installed packages)
      setPresetupKey((k) => k + 1)
    }
  }, [])

  // ── Connected view ─────────────────────────────────────────────
  if (isAuthenticated && currentTenant) {
    return (
      <>
        <SettingsSection
          title="20x Cloud"
          description="Connected to your organization's 20x Cloud"
        >
          <div className="space-y-4">
            {/* Connected status */}
            <div className="flex items-center gap-2 py-2">
              <div className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-sm font-medium text-foreground">Connected</span>
            </div>

            {/* User email */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="space-y-0.5">
                <Label>Email</Label>
                <p className="text-xs text-muted-foreground">
                  Signed in account
                </p>
              </div>
              <span className="text-sm text-foreground font-mono">
                {userEmail}
              </span>
            </div>

            {/* Current organization */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="space-y-0.5">
                <Label>Organization</Label>
                <p className="text-xs text-muted-foreground">
                  Currently active organization
                </p>
              </div>
              <span className="text-sm text-foreground font-medium">
                {currentTenant.name}
              </span>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSwitchOrg}
                disabled={isLoading}
              >
                Switch organization
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleLogout}
                disabled={isLoading}
              >
                Sign out
              </Button>
            </div>
          </div>
        </SettingsSection>

        {/* Setup Packages */}
        <SettingsSection
          title="Setup Packages"
          description="Pre-configured workflow packages available for your organization"
        >
          <PresetList key={presetupKey} onSelectTemplate={handleSelectTemplate} collapsible={false} />
        </SettingsSection>

        {/* Presetup Flow Dialog */}
        <PresetupFlow open={presetupOpen} onOpenChange={handlePresetupClose} />
      </>
    )
  }

  // ── Not connected view ─────────────────────────────────────────
  return (
    <>
      <SettingsSection
        title="20x Cloud"
        description="Connect to your organization's 20x Cloud to access enterprise features"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2 py-2">
            <div className="h-2 w-2 rounded-full bg-muted-foreground/40" />
            <span className="text-sm text-muted-foreground">Not connected</span>
          </div>

          <Button
            onClick={() => setShowLoginModal(true)}
            disabled={isLoading}
          >
            Sign in to 20x Cloud
          </Button>
        </div>
      </SettingsSection>

      <EnterpriseLoginModal
        open={showLoginModal}
        onClose={() => {
          setShowLoginModal(false)
          loadSession() // Refresh state after modal closes
        }}
      />
    </>
  )
}
