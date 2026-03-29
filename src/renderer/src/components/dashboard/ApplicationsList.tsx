import { Play, X, Loader2, AlertTriangle, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/Button'
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

export function ApplicationsList() {
  const {
    applications,
    applicationsLoading,
    applicationsError,
    activeApplicationId,
    activeApplicationUrl,
    applicationExecuting,
    applicationPolling,
    applicationError,
    applicationExecutionStatus,
    openApplication,
    closeApplication
  } = useDashboardStore()

  const isApplicationActive = activeApplicationId !== null

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Applications</h2>
        <span className="text-xs text-muted-foreground">
          {applications.length} workflow{applications.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Active application panel — executing, polling, error, or iframe */}
      {isApplicationActive && (
        <div className="rounded-lg border border-border/50 bg-[#161b22] mb-4 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border/50">
            <span className="text-xs font-medium">
              {applications.find((a) => a.workflowId === activeApplicationId)?.name || 'Application'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={closeApplication}
              title="Close application"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {applicationError ? (
            <div className="flex items-center justify-center p-12">
              <div className="text-center space-y-3 max-w-sm">
                <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
                <p className="text-sm font-medium">Execution Error</p>
                <p className="text-xs text-muted-foreground">{applicationError}</p>
              </div>
            </div>
          ) : applicationExecuting || applicationPolling ? (
            <div className="flex items-center justify-center p-12">
              <div className="text-center space-y-3">
                <div className="relative mx-auto w-10 h-10">
                  <Loader2 className="h-10 w-10 animate-spin text-primary/30" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Monitor className="h-4 w-4 text-primary" />
                  </div>
                </div>
                <p className="text-sm font-medium">
                  {applicationExecuting ? 'Executing Application' : 'Preparing Application'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {applicationExecuting
                    ? 'Starting your application workflow...'
                    : 'Waiting for application to be ready...'}
                </p>
                {applicationExecutionStatus && (
                  <p className="text-[11px] text-muted-foreground">
                    Status: {applicationExecutionStatus}
                  </p>
                )}
              </div>
            </div>
          ) : activeApplicationUrl ? (
            <iframe
              src={activeApplicationUrl}
              className="w-full border-0"
              style={{ height: '70vh' }}
              title="Application"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            />
          ) : (
            <div className="flex items-center justify-center p-12">
              <div className="text-center space-y-3">
                <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto" />
                <p className="text-sm font-medium">No Application Found</p>
                <p className="text-xs text-muted-foreground">
                  The workflow may not contain an application node or the URL was not generated.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

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
          {applications.map((app) => {
            const isActive = activeApplicationId === app.workflowId
            return (
              <div
                key={`${app.workflowId}-${app.tenantId}`}
                className={`rounded-lg border p-4 transition-colors cursor-pointer group ${
                  isActive
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border/50 bg-[#161b22] hover:border-border'
                }`}
                onClick={() => openApplication(app.workflowId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openApplication(app.workflowId) } }}
              >
                <div className="flex items-start justify-between mb-1">
                  <h3 className="text-sm font-medium truncate flex-1 mr-2">{app.name}</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    title="Run application"
                    onClick={(e) => { e.stopPropagation(); openApplication(app.workflowId) }}
                  >
                    <Play className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                  {app.description || 'No description'}
                </p>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span>Last run: {formatLastRun(app.lastRun)}</span>
                  <span>Runs: {app.runCount}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
