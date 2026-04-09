import { useState, useEffect, useCallback } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { EnterpriseLoginModal } from './EnterpriseLoginModal'

export function EnterpriseSettings() {
  const {
    isAuthenticated,
    isLoading,
    isSyncing,
    userEmail,
    currentTenant,
    logout,
    loadSession,
    setSyncing
  } = useEnterpriseStore()

  const [showLoginModal, setShowLoginModal] = useState(false)

  useEffect(() => {
    loadSession()
  }, [loadSession])

  // Listen for background sync completion from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI?.enterprise?.onSyncComplete?.((data) => {
      setSyncing(false)
      if (data.success) {
        console.log(`[enterprise] Sync completed in ${data.syncMs}ms`)
      } else {
        console.warn('[enterprise] Sync failed:', data.error)
      }
    })
    return () => unsubscribe?.()
  }, [setSyncing])

  const handleLogout = useCallback(async () => {
    await logout()
  }, [logout])

  const handleSwitchOrg = useCallback(() => {
    // Clear current tenant and open modal for re-selection
    useEnterpriseStore.setState({
      isAuthenticated: false,
      currentTenant: null,
      availableTenants: null
    })
    // Logout to start fresh (need to re-authenticate to get companies list)
    logout().then(() => setShowLoginModal(true))
  }, [logout])

  // ── Connected view ─────────────────────────────────────────────
  if (isAuthenticated && currentTenant) {
    return (
      <SettingsSection
        title="20x Cloud"
        description="Connected to your organization's 20x Cloud"
      >
        <div className="space-y-4">
          {/* Connected status */}
          <div className="flex items-center gap-2 py-2">
            {isSyncing ? (
              <>
                <svg className="animate-spin h-3 w-3 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-sm font-medium text-foreground">Connected — Syncing...</span>
              </>
            ) : (
              <>
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span className="text-sm font-medium text-foreground">Connected</span>
              </>
            )}
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
