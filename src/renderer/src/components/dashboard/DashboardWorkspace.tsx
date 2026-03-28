import { useEffect } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDashboardStore, type TimeWindow } from '@/stores/dashboard-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'
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
  const {
    timeWindow,
    setTimeWindow,
    fetchAll,
    applicationsLoading,
    statsLoading,
    tasksLoading
  } = useDashboardStore()

  const isLoading = applicationsLoading || statsLoading || tasksLoading

  useEffect(() => {
    if (isAuthenticated) {
      fetchAll()
    }
  }, [isAuthenticated])

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <h2 className="text-lg font-semibold mb-2">Connect to 20x Cloud</h2>
          <p className="text-sm text-muted-foreground">
            Sign in to your enterprise account in Settings → Enterprise to view your dashboard.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Applications, stats, and task overview
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Time window selector */}
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
          </div>
        </div>

        {/* Stats Section */}
        <StatsSection />

        {/* Applications List */}
        <ApplicationsList />

        {/* Task Kanban Board */}
        <TaskBoard />
      </div>
    </div>
  )
}
