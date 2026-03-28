import { Play, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useDashboardStore } from '@/stores/dashboard-store'

function formatLastRun(lastRun: string | null): string {
  if (!lastRun) return 'Never'
  const now = new Date()
  const runDate = new Date(lastRun)
  const diffMs = now.getTime() - runDate.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffHours < 1) return 'Just now'
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return '1d ago'
  return `${diffDays}d ago`
}

function getStatusVariant(status: string): 'default' | 'green' | 'yellow' | 'blue' {
  switch (status.toLowerCase()) {
    case 'active':
      return 'green'
    case 'draft':
      return 'default'
    case 'paused':
      return 'yellow'
    default:
      return 'default'
  }
}

export function ApplicationsList() {
  const { applications, applicationsLoading, applicationsError } = useDashboardStore()

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Applications</h2>
        <span className="text-xs text-muted-foreground">
          {applications.length} workflow{applications.length !== 1 ? 's' : ''}
        </span>
      </div>

      {applicationsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border border-border/50 bg-[#161b22] p-4">
              <div className="h-4 w-32 rounded bg-muted/50 animate-pulse mb-2" />
              <div className="h-3 w-48 rounded bg-muted/30 animate-pulse mb-3" />
              <div className="h-3 w-20 rounded bg-muted/30 animate-pulse" />
            </div>
          ))}
        </div>
      ) : applicationsError ? (
        <div className="rounded-lg border border-border/50 bg-[#161b22] p-6 text-center">
          <p className="text-sm text-muted-foreground">{applicationsError}</p>
        </div>
      ) : applications.length === 0 ? (
        <div className="rounded-lg border border-border/50 bg-[#161b22] p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No applications found. Applications appear here when workflows with application triggers are created.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {applications.map((app) => (
            <div
              key={`${app.workflowId}-${app.tenantId}`}
              className="rounded-lg border border-border/50 bg-[#161b22] p-4 hover:border-border transition-colors group"
            >
              <div className="flex items-start justify-between mb-1">
                <h3 className="text-sm font-medium truncate flex-1 mr-2">{app.name}</h3>
                <Badge variant={getStatusVariant(app.status)} className="text-[10px] px-1.5 py-0 shrink-0">
                  {app.status}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                {app.description || 'No description'}
              </p>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span>Last run: {formatLastRun(app.lastRun)}</span>
                  <span>Runs: {app.runCount}</span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Run application">
                    <Play className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Open in workflow builder">
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
