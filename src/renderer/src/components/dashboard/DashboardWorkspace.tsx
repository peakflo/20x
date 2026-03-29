import { useEffect } from 'react'
import { RefreshCw, Loader2, Cloud } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDashboardStore, type TimeWindow } from '@/stores/dashboard-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useTaskStore } from '@/stores/task-store'
import { StatsSection } from './StatsSection'
import { ApplicationsList } from './ApplicationsList'
import { TaskBoard } from './TaskBoard'

const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All'
}

export function DashboardWorkspace() {
  const { isAuthenticated } = useEnterpriseStore()
  const { tasks } = useTaskStore()
  const {
    timeWindow,
    setTimeWindow,
    fetchAll,
    updateLocalStats,
    applicationsLoading,
    statsLoading
  } = useDashboardStore()

  const isLoading = applicationsLoading || statsLoading

  // Always compute local stats from task store
  useEffect(() => {
    updateLocalStats(tasks)
  }, [tasks, timeWindow])

  // Fetch cloud data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchAll()
    }
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
                disabled={isLoading}
                title="Refresh all"
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Stats — always available (local data fallback when not connected) */}
        <StatsSection />

        {/* Applications — cloud only, shows connect prompt when not authenticated */}
        {isAuthenticated ? (
          <ApplicationsList />
        ) : (
          <div className="rounded-lg border border-border/50 bg-[#161b22] p-4 flex items-center gap-3">
            <Cloud className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium">Connect to 20x Cloud for more insights</p>
              <p className="text-xs text-muted-foreground">
                Sign in via Settings → Enterprise to see application workflows and enhanced stats.
              </p>
            </div>
          </div>
        )}

        {/* Task Kanban Board — always available (local data) */}
        <TaskBoard />
      </div>
    </div>
  )
}
