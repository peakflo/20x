import { useEffect, useCallback, useState } from 'react'
import { Cloud, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { HeroSection } from './HeroSection'
import { CommandInput } from './CommandInput'
import { QuickChips } from './QuickChips'
import { PresetupSection } from './PresetupSection'
import { ApplicationsList } from './ApplicationsList'
import { TaskBoard } from './TaskBoard'
import { EnterpriseLoginModal } from '@/components/settings/tabs/EnterpriseLoginModal'

export function DashboardWorkspace() {
  const {
    isAuthenticated,
    isLoading: enterpriseLoading,
    error: enterpriseError,
    availableTenants,
    loadSession,
    clearError,
    setSyncing,
    setSyncResult
  } = useEnterpriseStore()
  const [showLoginModal, setShowLoginModal] = useState(false)

  // After browser signup returns companies that need tenant selection, open the modal
  useEffect(() => {
    if (availableTenants && availableTenants.length > 1 && !isAuthenticated) {
      setShowLoginModal(true)
    }
  }, [availableTenants, isAuthenticated])

  // Listen for sync completion from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI?.enterprise?.onSyncComplete?.((data) => {
      setSyncing(false)
      if (data.success) {
        console.log(`[enterprise] Sync completed in ${data.syncMs}ms`)
        setSyncResult(data.syncStats ?? null, data.syncMs ?? null)
      } else {
        console.warn('[enterprise] Sync failed:', data.error)
      }
    })
    return () => unsubscribe?.()
  }, [setSyncing, setSyncResult])

  const tasks = useTaskStore((s) => s.tasks)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const openCreateWithPrefill = useUIStore((s) => s.openCreateWithPrefill)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const timeWindow = useDashboardStore((s) => s.timeWindow)
  const fetchAllIfNeeded = useDashboardStore((s) => s.fetchAllIfNeeded)
  const startPeriodicRefresh = useDashboardStore((s) => s.startPeriodicRefresh)
  const stopPeriodicRefresh = useDashboardStore((s) => s.stopPeriodicRefresh)
  const updateLocalStats = useDashboardStore((s) => s.updateLocalStats)

  // Restore saved enterprise session on mount
  useEffect(() => {
    loadSession()
  }, [])

  // Always compute local stats from task store
  useEffect(() => {
    updateLocalStats(tasks)
  }, [tasks, timeWindow])

  // Fetch cloud data when authenticated
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

  // Handler: send message to Mastermind and open the drawer
  const handleSendToMastermind = useCallback((message: string) => {
    // Open the orchestrator panel — the panel itself handles sending messages
    setShowOrchestrator(true)
    // We dispatch a custom event so the OrchestratorPanel can pick up the message
    window.dispatchEvent(new CustomEvent('mastermind-prefill', { detail: { message } }))
  }, [setShowOrchestrator])

  // Handler: create task from command input text
  const handleCreateTask = useCallback((text: string) => {
    if (text) {
      openCreateWithPrefill(text)
    } else {
      openCreateWithPrefill('')
    }
  }, [openCreateWithPrefill])

  // Handler: open Mastermind drawer from hero "See full conversation"
  const handleSeeFullConversation = useCallback(() => {
    setShowOrchestrator(true)
  }, [setShowOrchestrator])

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      {/* Command center — centered narrow column */}
      <div className="max-w-2xl mx-auto px-6 pt-8 pb-6 space-y-5">
        {/* 1. Hero — Recent Mastermind Messages */}
        <HeroSection onSeeFullConversation={handleSeeFullConversation} />

        {/* 2. Command Input */}
        <CommandInput
          onSendToMastermind={handleSendToMastermind}
          onCreateTask={handleCreateTask}
        />

        {/* 3. Quick Task Chips */}
        <QuickChips
          onAskMastermind={handleSendToMastermind}
          onCreateTask={(text) => openCreateWithPrefill(text)}
        />
      </div>

      {/* Full-width sections below — constrained + centered to align with kanban */}
      <div className="max-w-[1600px] mx-auto px-6 space-y-6 pb-8">
        {/* Cloud connect prompt — when not authenticated */}
        {!isAuthenticated && (
          <>
            <div className="max-w-2xl mx-auto rounded-lg border border-border/50 bg-card p-4 space-y-3">
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
                    onClick={() => setShowLoginModal(true)}
                    disabled={enterpriseLoading}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    Connect
                  </Button>
                </div>
              </div>
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

            <EnterpriseLoginModal
              open={showLoginModal}
              onClose={() => {
                setShowLoginModal(false)
                loadSession()
              }}
            />
          </>
        )}

        {/* 4. Launch an Application — cloud only, full width */}
        {isAuthenticated && <ApplicationsList />}

        {/* 5. Start with a Template — cloud only, full width */}
        {isAuthenticated && <PresetupSection />}

        {/* 6. Task Board (Kanban) — full width */}
        <TaskBoard />
      </div>
    </div>
  )
}
