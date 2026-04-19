import { useEffect, useCallback, useState } from 'react'
import { RefreshCw, Cloud, Plus, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDashboardStore, type TimeWindow } from '@/stores/dashboard-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { StatsSection } from './StatsSection'
import { PresetupSection } from './PresetupSection'
import { ApplicationsList } from './ApplicationsList'
import { TaskBoard } from './TaskBoard'
import { EnterpriseLoginModal } from '@/components/settings/tabs/EnterpriseLoginModal'

const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All'
}

export function DashboardWorkspace() {
  const {
    isAuthenticated,
    isLoading: enterpriseLoading,
    error: enterpriseError,
    availableTenants,
    signupInBrowser,
    loadSession,
    clearError,
    setSyncing
  } = useEnterpriseStore()
  const [signupPending, setSignupPending] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)

  const handleSignupInBrowser = useCallback(async () => {
    setSignupPending(true)
    try {
      await signupInBrowser('register')
    } finally {
      setSignupPending(false)
    }
  }, [signupInBrowser])

  // After browser signup returns companies that need tenant selection, open the modal
  useEffect(() => {
    if (availableTenants && availableTenants.length > 1 && !isAuthenticated) {
      setShowLoginModal(true)
    }
  }, [availableTenants, isAuthenticated])

  // Listen for sync completion from main process (also needed when connecting from dashboard)
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

  const { tasks } = useTaskStore()
  const { openSettings, setSettingsTab, openCreateModal } = useUIStore()
  const {
    timeWindow,
    setTimeWindow,
    fetchAll,
    fetchAllIfNeeded,
    startPeriodicRefresh,
    stopPeriodicRefresh,
    updateLocalStats,
    isRefreshing
  } = useDashboardStore()

  // Restore saved enterprise session on mount
  useEffect(() => {
    loadSession()
  }, [])

  // Always compute local stats from task store
  useEffect(() => {
    updateLocalStats(tasks)
  }, [tasks, timeWindow])

  // Fetch cloud data when authenticated — only on first load, then periodically.
  // When isAuthenticated goes false (logout / session expiry), reset dashboard
  // fetch state so the next login triggers a fresh data load instead of being
  // short-circuited by the stale hasFetchedOnce flag.
  useEffect(() => {
    if (isAuthenticated) {
      fetchAllIfNeeded()
      startPeriodicRefresh()
    } else {
      useDashboardStore.setState({
        hasFetchedOnce: false,
        applicationsError: null,
        statsError: null
      })
    }
    return () => stopPeriodicRefresh()
  }, [isAuthenticated])

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {isAuthenticated
                ? 'Applications, stats, and task overview'
                : 'Stats and task overview'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={openCreateModal}
              title="Create new task"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Task
            </Button>
            {/* Time window selector — always available */}
            <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
              {(Object.keys(TIME_WINDOW_LABELS) as TimeWindow[]).map((w) => (
                <button
                  key={w}
                  onClick={() => setTimeWindow(w)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    timeWindow === w
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {TIME_WINDOW_LABELS[w]}
                </button>
              ))}
            </div>
            {isAuthenticated && (
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchAll}
                disabled={isRefreshing}
                title="Refresh all"
              >
                <RefreshCw className={`h-3.5 w-3.5 transition-transform ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            )}
          </div>
        </div>

        {/* Stats — always available (local data fallback when not connected) */}
        <StatsSection />

        {/* Presetups + Applications — cloud only, shows connect prompt when not authenticated */}
        {isAuthenticated ? (
          <>
            <PresetupSection />
            <ApplicationsList />
          </>
        ) : (
          <>
          <div className="rounded-lg border border-border/50 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Cloud className="h-5 w-5 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium">Connect to 20x Cloud</p>
                  <p className="text-xs text-muted-foreground">
                    See application workflows and enhanced stats.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSignupInBrowser}
                  disabled={signupPending || enterpriseLoading}
                >
                  {signupPending ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Waiting...
                    </span>
                  ) : (
                    <>
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                      Connect
                    </>
                  )}
                </Button>
              </div>
            </div>
            {signupPending && (
              <p className="text-xs text-muted-foreground">
                Complete sign up in your browser, then you'll be connected automatically.
              </p>
            )}
            {enterpriseError && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 flex items-center justify-between">
                <p className="text-xs text-destructive">{enterpriseError}</p>
                <button
                  onClick={clearError}
                  className="text-xs text-destructive/70 hover:text-destructive underline ml-2 shrink-0 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Already have an account?</span>
              <button
                className="text-xs text-primary hover:underline cursor-pointer"
                onClick={() => {
                  setSettingsTab(SettingsTab.ENTERPRISE)
                  openSettings()
                }}
              >
                Sign in
              </button>
            </div>
          </div>

          {/* Tenant selection modal — shown after browser signup when multiple orgs exist */}
          <EnterpriseLoginModal
            open={showLoginModal}
            onClose={() => {
              setShowLoginModal(false)
              loadSession()
            }}
          />
          </>
        )}

        {/* Task Kanban Board — always available (local data) */}
        <TaskBoard />
      </div>
    </div>
  )
}
