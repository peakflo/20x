import { Loader2, AlertTriangle, Monitor, Play } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard-store'
import type { ApplicationTab } from '@/stores/dashboard-store'

function TabContent({ tab }: { tab: ApplicationTab }) {
  if (tab.error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-sm">
          <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
          <p className="text-sm font-medium">Execution Error</p>
          <p className="text-xs text-muted-foreground">{tab.error}</p>
        </div>
      </div>
    )
  }

  if (tab.executing || tab.polling) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <div className="relative mx-auto w-10 h-10">
            <Loader2 className="h-10 w-10 animate-spin text-primary/30" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Monitor className="h-4 w-4 text-primary" />
            </div>
          </div>
          <p className="text-sm font-medium">
            {tab.executing ? 'Executing Application' : 'Preparing Application'}
          </p>
          <p className="text-xs text-muted-foreground">
            {tab.executing
              ? 'Starting your application workflow...'
              : 'Waiting for application to be ready...'}
          </p>
          {tab.executionStatus && (
            <p className="text-[11px] text-muted-foreground">
              Status: {tab.executionStatus}
            </p>
          )}
        </div>
      </div>
    )
  }

  return null
}

function EmptyTabContent() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3">
        <Play className="h-8 w-8 text-muted-foreground mx-auto" />
        <p className="text-sm font-medium">Select an application</p>
        <p className="text-xs text-muted-foreground">
          Click a tab above to launch the application
        </p>
      </div>
    </div>
  )
}

export function ApplicationsList() {
  const {
    applications,
    applicationsLoading,
    applicationsError,
    openTabs,
    activeTabId,
    openApplication,
    switchTab
  } = useDashboardStore()

  if (applicationsLoading) {
    return (
      <section>
        <div className="rounded-lg border border-border/50 bg-[#161b22] p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading applications...</span>
          </div>
        </div>
      </section>
    )
  }

  if (applicationsError) {
    return (
      <section>
        <div className="rounded-lg border border-border/50 bg-[#161b22] p-6 text-center">
          <p className="text-sm text-muted-foreground">{applicationsError}</p>
        </div>
      </section>
    )
  }

  if (applications.length === 0) {
    return (
      <section>
        <div className="rounded-lg border border-border/50 bg-[#161b22] p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No applications found. Applications appear here when workflows with application triggers are created.
          </p>
        </div>
      </section>
    )
  }

  const activeTab = openTabs.find((t) => t.workflowId === activeTabId)

  return (
    <section className="flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Tab bar — all applications as tabs */}
      <div className="flex items-center border-b border-border/50 overflow-x-auto shrink-0 bg-[#161b22] rounded-t-lg">
        {applications.map((app) => {
          const tab = openTabs.find((t) => t.workflowId === app.workflowId)
          const isActive = activeTabId === app.workflowId
          const isLoading = tab?.executing || tab?.polling
          const hasError = !!tab?.error
          const isReady = !!tab?.url && !isLoading && !hasError

          return (
            <div
              key={app.workflowId}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs cursor-pointer border-r border-border/50 shrink-0 transition-colors ${
                isActive
                  ? 'bg-background/50 text-foreground border-b-2 border-b-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/20'
              }`}
              onClick={() => {
                if (tab) {
                  switchTab(app.workflowId)
                } else {
                  openApplication(app.workflowId)
                }
              }}
              role="tab"
              aria-selected={isActive}
            >
              {isLoading && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
              {hasError && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
              {isReady && <div className="h-2 w-2 rounded-full bg-green-500 shrink-0" />}
              <span className="truncate max-w-[140px] font-medium">
                {app.name}
              </span>
            </div>
          )
        })}
      </div>

      {/* Content area — all opened iframes stacked, only active visible */}
      <div className="flex-1 relative bg-[#161b22] rounded-b-lg overflow-hidden">
        {/* Placeholder when no tab is active */}
        {!activeTab && <EmptyTabContent />}

        {/* Render all opened iframes — hidden ones stay mounted to avoid reload */}
        {openTabs.map((tab) => {
          const isActive = activeTabId === tab.workflowId
          const showIframe = tab.url && !tab.error && !tab.executing && !tab.polling
          return (
            <div
              key={tab.workflowId}
              className="absolute inset-0"
              style={{ display: isActive ? 'block' : 'none' }}
            >
              {showIframe ? (
                <iframe
                  src={tab.url!}
                  className="w-full h-full border-0"
                  title={`Application - ${tab.workflowId}`}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                />
              ) : (
                <TabContent tab={tab} />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
