import { Loader2, AlertTriangle, Monitor, Play, Minimize2, X, AppWindow, Layers } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useUIStore } from '@/stores/ui-store'
import type { ApplicationTab, ApplicationItem } from '@/stores/dashboard-store'

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

function ApplicationCard({
  app,
  tab,
  onClick
}: {
  app: ApplicationItem
  tab: ApplicationTab | undefined
  onClick: () => void
}) {
  const openAppOnCanvas = useUIStore((s) => s.openAppOnCanvas)
  const isLoading = tab?.executing || tab?.polling
  const hasError = !!tab?.error
  const isReady = !!tab?.url && !isLoading && !hasError

  return (
    <div
      className="rounded-lg border border-border/50 bg-card p-4 cursor-pointer transition-all hover:border-border hover:bg-secondary group"
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 shrink-0">
          <AppWindow className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium truncate">{app.name}</h3>
            {isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
            {hasError && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
            {isReady && <div className="h-2 w-2 rounded-full bg-green-500 shrink-0" />}
          </div>
          {app.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{app.description}</p>
          )}
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="capitalize">{app.status}</span>
              {app.runCount > 0 && <span>{app.runCount} runs</span>}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                openAppOnCanvas(app.workflowId, app.name)
              }}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-primary transition-colors px-1.5 py-0.5 rounded border border-border/40 hover:border-primary/40 hover:bg-primary/10"
              title="Open in Canvas"
            >
              <Layers className="h-3 w-3" />
              <span>Canvas</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CardsView() {
  const { applications, openTabs, openApplication } = useDashboardStore()

  return (
    <section>
      <h2 className="text-sm font-semibold mb-3">Applications</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {applications.map((app) => {
          const tab = openTabs.find((t) => t.workflowId === app.workflowId)
          return (
            <ApplicationCard
              key={app.workflowId}
              app={app}
              tab={tab}
              onClick={() => openApplication(app.workflowId)}
            />
          )
        })}
      </div>
    </section>
  )
}

function ExpandedView() {
  const {
    applications,
    openTabs,
    activeTabId,
    openApplication,
    switchTab,
    closeTab,
    minimizeToCards
  } = useDashboardStore()
  const openAppOnCanvas = useUIStore((s) => s.openAppOnCanvas)

  const activeTab = openTabs.find((t) => t.workflowId === activeTabId)

  // Build a lookup from workflowId → application name for open tabs
  const appNameByWorkflowId = new Map(
    applications.map((a) => [a.workflowId, a.name])
  )

  // Applications that are not yet opened (available for launching)
  const unopenedApps = applications.filter(
    (app) => !openTabs.some((t) => t.workflowId === app.workflowId)
  )

  return (
    <section className="flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Tab bar with minimize button */}
      <div className="flex items-center border-b border-border/50 shrink-0 bg-card rounded-t-lg">
        <div className="flex items-center overflow-x-auto flex-1">
          {/* Render tab headers from openTabs only — correlate by workflowId */}
          {openTabs.map((tab) => {
            const isActive = activeTabId === tab.workflowId
            const isLoading = tab.executing || tab.polling
            const hasError = !!tab.error
            const isReady = !!tab.url && !isLoading && !hasError

            return (
              <div
                key={tab.workflowId}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs cursor-pointer border-r border-border/50 shrink-0 transition-colors ${
                  isActive
                    ? 'bg-background/50 text-foreground border-b-2 border-b-primary'
                    : 'text-foreground/70 hover:text-foreground hover:bg-background/20'
                }`}
                onClick={() => switchTab(tab.workflowId)}
                role="tab"
                aria-selected={isActive}
              >
                {isLoading && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                {hasError && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                {isReady && <div className="h-2 w-2 rounded-full bg-green-500 shrink-0" />}
                <span className="truncate max-w-[140px] font-medium">
                  {appNameByWorkflowId.get(tab.workflowId) || tab.workflowId}
                </span>
                <button
                  className="ml-1 rounded p-0.5 hover:bg-background/40 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.workflowId)
                  }}
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}

          {/* Launcher buttons for unopened applications */}
          {unopenedApps.map((app) => (
            <div
              key={app.workflowId}
              className="flex items-center gap-1.5 px-4 py-2.5 text-xs cursor-pointer border-r border-border/50 shrink-0 transition-colors text-muted-foreground hover:text-foreground hover:bg-background/20"
              onClick={() => openApplication(app.workflowId)}
              role="tab"
              aria-selected={false}
            >
              <span className="truncate max-w-[140px] font-medium">
                {app.name}
              </span>
            </div>
          ))}
        </div>

        {/* Open active app in Canvas */}
        {activeTabId && (
          <button
            className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-muted-foreground hover:text-primary transition-colors shrink-0 border-l border-border/50 cursor-pointer"
            onClick={() => {
              const name = appNameByWorkflowId.get(activeTabId) || 'Application'
              openAppOnCanvas(activeTabId, name)
            }}
            title="Open in Canvas"
          >
            <Layers className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Canvas</span>
          </button>
        )}

        {/* Minimize back to cards */}
        <button
          className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 border-l border-border/50 cursor-pointer"
          onClick={minimizeToCards}
          title="Minimize to cards"
        >
          <Minimize2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Minimize</span>
        </button>
      </div>

      {/* Content area — all opened iframes stacked, only active visible */}
      <div className="flex-1 relative bg-card rounded-b-lg overflow-hidden">
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

export function ApplicationsList() {
  const {
    applications,
    applicationsLoading,
    applicationsError,
    expandedView,
    openTabs
  } = useDashboardStore()

  // When the expanded view is active with open tabs, never unmount it —
  // replacing it with a loading spinner would destroy all live iframes.
  if (expandedView && openTabs.length > 0) {
    return <ExpandedView />
  }

  // Only show loading skeleton on initial load when there's no cached data
  if (applicationsLoading && applications.length === 0) {
    return (
      <section>
        <div className="rounded-lg border border-border/50 bg-card p-6">
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
        <div className="rounded-lg border border-border/50 bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">{applicationsError}</p>
        </div>
      </section>
    )
  }

  if (applications.length === 0) {
    return null
  }

  return expandedView ? <ExpandedView /> : <CardsView />
}
