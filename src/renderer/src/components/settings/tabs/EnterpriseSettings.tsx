import { useState, useEffect, useCallback } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { enterpriseApi } from '@/lib/ipc-client'
import { EnterpriseLoginModal } from './EnterpriseLoginModal'

// ── Types for the GET /plan response ────────────────────────────
interface AiGatewayPlan {
  id: string
  name: string
  monthlyBudgetUsd: number
  dailyBudgetUsd: number
}

interface AiGatewaySubscription {
  planId: string
  status: 'active' | 'suspended' | 'cancelled'
  currentPeriodStart: string
  currentPeriodEnd: string
}

interface PlanResponse {
  plans: AiGatewayPlan[]
  currentSubscription: AiGatewaySubscription | null
}

// ── Plan & Usage sub-component ──────────────────────────────────
function PlanUsageSection() {
  const [planData, setPlanData] = useState<PlanResponse | null>(null)
  const [isLoadingPlan, setIsLoadingPlan] = useState(true)
  const [planError, setPlanError] = useState<string | null>(null)

  const fetchPlan = useCallback(async () => {
    setIsLoadingPlan(true)
    setPlanError(null)
    try {
      const resp = await enterpriseApi.apiRequest('GET', '/api/20x/ai-gateway/plan')
      setPlanData(resp as PlanResponse)
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to load plan')
    } finally {
      setIsLoadingPlan(false)
    }
  }, [])

  useEffect(() => {
    fetchPlan()
  }, [fetchPlan])

  // Loading skeleton
  if (isLoadingPlan) {
    return (
      <SettingsSection title="Plan & Usage" description="AI gateway subscription">
        <div className="space-y-3 animate-pulse">
          <div className="h-4 w-32 bg-muted rounded" />
          <div className="h-4 w-48 bg-muted rounded" />
        </div>
      </SettingsSection>
    )
  }

  // Error state
  if (planError) {
    return (
      <SettingsSection title="Plan & Usage" description="AI gateway subscription">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{planError}</span>
          <Button variant="secondary" size="sm" onClick={fetchPlan}>
            Retry
          </Button>
        </div>
      </SettingsSection>
    )
  }

  const sub = planData?.currentSubscription
  const activePlan = sub
    ? planData?.plans.find((p) => p.id === sub.planId)
    : null

  return (
    <SettingsSection title="Plan & Usage" description="AI gateway subscription">
      <div className="space-y-4">
        {/* Plan name + status */}
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label>Current plan</Label>
            <p className="text-xs text-muted-foreground">
              AI model access tier
            </p>
          </div>
          {activePlan && sub ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground font-medium">
                {activePlan.name}
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  sub.status === 'active'
                    ? 'bg-green-500/10 text-green-500'
                    : sub.status === 'suspended'
                      ? 'bg-yellow-500/10 text-yellow-500'
                      : 'bg-red-500/10 text-red-400'
                }`}
              >
                {sub.status}
              </span>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">No active plan</span>
          )}
        </div>

        {/* Budget */}
        {activePlan && (
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>Budget</Label>
              <p className="text-xs text-muted-foreground">
                Monthly AI spend limit
              </p>
            </div>
            <span className="text-sm text-foreground font-mono">
              ${activePlan.monthlyBudgetUsd}/mo
            </span>
          </div>
        )}

        {/* Billing period */}
        {sub && (
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>Billing period</Label>
              <p className="text-xs text-muted-foreground">
                Current cycle
              </p>
            </div>
            <span className="text-sm text-foreground font-mono">
              {new Date(sub.currentPeriodStart).toLocaleDateString()} — {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </span>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}

// ── Main component ──────────────────────────────────────────────
export function EnterpriseSettings() {
  const {
    isAuthenticated,
    isLoading,
    isSyncing,
    userEmail,
    currentTenant,
    switchOrg,
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
      <div className="space-y-8">
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

        <PlanUsageSection />
      </div>
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
