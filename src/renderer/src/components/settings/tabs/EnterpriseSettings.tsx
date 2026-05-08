import { useState, useEffect, useCallback } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { EnterpriseLoginModal } from './EnterpriseLoginModal'
import { enterpriseApi } from '@/lib/ipc-client'

interface AiGatewayStatus {
  configured: boolean
  modelCount: number
  keyName: string | null
  expiresAt: string | null
  subscription: {
    planName: string
    status: string
    planId: string
    currentPeriodEnd: string | null
  } | null
}

export function EnterpriseSettings() {
  const {
    isAuthenticated,
    isLoading,
    isSyncing,
    userEmail,
    currentTenant,
    lastSyncStats,
    lastSyncMs,
    switchOrg,
    logout,
    loadSession,
    setSyncing,
    setSyncResult
  } = useEnterpriseStore()

  const [showLoginModal, setShowLoginModal] = useState(false)
  const [aiGatewayStatus, setAiGatewayStatus] = useState<AiGatewayStatus | null>(null)

  useEffect(() => {
    loadSession()
  }, [loadSession])

  // Fetch AI gateway status when authenticated
  useEffect(() => {
    if (isAuthenticated && currentTenant) {
      enterpriseApi.getAiGatewayStatus().then(setAiGatewayStatus).catch(() => {
        setAiGatewayStatus(null)
      })
    } else {
      setAiGatewayStatus(null)
    }
  }, [isAuthenticated, currentTenant])

  // Listen for background sync completion from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI?.enterprise?.onSyncComplete?.((data) => {
      setSyncing(false)
      if (data.success) {
        console.log(`[enterprise] Sync completed in ${data.syncMs}ms`)
        setSyncResult(data.syncStats ?? null, data.syncMs ?? null)
      } else {
        console.warn('[enterprise] Sync failed:', data.error)
      }
      // Refresh AI gateway status after sync
      enterpriseApi.getAiGatewayStatus().then(setAiGatewayStatus).catch(() => {})
    })
    return () => unsubscribe?.()
  }, [setSyncing, setSyncResult])

  const handleLogout = useCallback(async () => {
    await logout()
  }, [logout])

  const handleSwitchOrg = useCallback(async () => {
    // Fetch companies using existing session (no re-login needed)
    await switchOrg()
    // Open modal — it will show the tenant selection step since
    // availableTenants is now populated and currentTenant is cleared
    setShowLoginModal(true)
  }, [switchOrg])

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

          {/* AI Gateway status */}
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>AI Gateway</Label>
              <p className="text-xs text-muted-foreground">
                Peakflo AI model access
              </p>
            </div>
            <div className="text-right">
              {aiGatewayStatus === null ? (
                <span className="text-sm text-muted-foreground">Loading...</span>
              ) : aiGatewayStatus.configured ? (
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 justify-end">
                    <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    <span className="text-sm text-foreground">
                      {aiGatewayStatus.modelCount} model{aiGatewayStatus.modelCount !== 1 ? 's' : ''} available
                    </span>
                  </div>
                  {aiGatewayStatus.expiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Key expires {new Date(aiGatewayStatus.expiresAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                  <span className="text-sm text-muted-foreground">Not configured</span>
                </div>
              )}
            </div>
          </div>

          {/* AI Gateway subscription */}
          {aiGatewayStatus && (
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="space-y-0.5">
                <Label>AI Subscription</Label>
                <p className="text-xs text-muted-foreground">
                  Current plan and billing status
                </p>
              </div>
              <div className="text-right">
                {aiGatewayStatus.subscription ? (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 justify-end">
                      <div className={`h-1.5 w-1.5 rounded-full ${
                        aiGatewayStatus.subscription.status === 'active'
                          ? 'bg-green-500'
                          : aiGatewayStatus.subscription.status === 'suspended'
                            ? 'bg-yellow-500'
                            : 'bg-red-500'
                      }`} />
                      <span className="text-sm text-foreground">
                        {aiGatewayStatus.subscription.planName}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                        aiGatewayStatus.subscription.status === 'active'
                          ? 'bg-green-500/10 text-green-500'
                          : aiGatewayStatus.subscription.status === 'suspended'
                            ? 'bg-yellow-500/10 text-yellow-500'
                            : 'bg-red-500/10 text-red-500'
                      }`}>
                        {aiGatewayStatus.subscription.status}
                      </span>
                    </div>
                    {aiGatewayStatus.subscription.currentPeriodEnd && (
                      <p className="text-xs text-muted-foreground">
                        Period ends {new Date(aiGatewayStatus.subscription.currentPeriodEnd).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    <span className="text-sm text-muted-foreground">No plan selected</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sync stats */}
          {lastSyncStats && (
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="space-y-0.5">
                <Label>Last Sync</Label>
                <p className="text-xs text-muted-foreground">
                  Resources synced from cloud{lastSyncMs ? ` (${(lastSyncMs / 1000).toFixed(1)}s)` : ''}
                </p>
              </div>
              <div className="text-right space-y-0.5">
                <div className="flex items-center gap-3 justify-end text-sm text-foreground">
                  <span title="Skills synced from cloud">
                    {lastSyncStats.skills.created + lastSyncStats.skills.updated} skill{lastSyncStats.skills.created + lastSyncStats.skills.updated !== 1 ? 's' : ''} synced
                  </span>
                  {lastSyncStats.skills.pushed > 0 && (
                    <span className="text-xs text-muted-foreground" title="Skills pushed to cloud">
                      ({lastSyncStats.skills.pushed} pushed)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 justify-end text-xs text-muted-foreground">
                  {(lastSyncStats.agents.created + lastSyncStats.agents.updated) > 0 && (
                    <span>{lastSyncStats.agents.created + lastSyncStats.agents.updated} agent{lastSyncStats.agents.created + lastSyncStats.agents.updated !== 1 ? 's' : ''}</span>
                  )}
                  {(lastSyncStats.mcpServers.created + lastSyncStats.mcpServers.updated) > 0 && (
                    <span>{lastSyncStats.mcpServers.created + lastSyncStats.mcpServers.updated} MCP server{lastSyncStats.mcpServers.created + lastSyncStats.mcpServers.updated !== 1 ? 's' : ''}</span>
                  )}
                </div>
                {lastSyncStats.errors.length > 0 && (
                  <p className="text-xs text-red-400" title={lastSyncStats.errors.join('\n')}>
                    {lastSyncStats.errors.length} error{lastSyncStats.errors.length !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            </div>
          )}

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
