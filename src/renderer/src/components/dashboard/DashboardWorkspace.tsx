import { useEffect } from 'react'
import { RefreshCw, Cloud, Plus } from 'lucide-react'
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

const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All'
}

export function DashboardWorkspace() {
  const { isAuthenticated, loadSession } = useEnterpriseStore()
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

  // Fetch cloud data when authenticated — only on first load, then periodically
  useEffect(() => {
    if (isAuthenticated) {
      fetchAllIfNeeded()
      startPeriodicRefresh()
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
          <div className="rounded-lg border border-border/50 bg-card p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Cloud className="h-5 w-5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium">Connect to 20x Cloud</p>
                <p className="text-xs text-muted-foreground">
                  See application workflows and enhanced stats.
                </p>
              </div>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setSettingsTab(SettingsTab.ENTERPRISE)
                openSettings()
              }}
            >
              Connect
            </Button>
          </div>
        )}

        {/* Task Kanban Board — always available (local data) */}
        <TaskBoard />
      </div>
    </div>
  )
}
