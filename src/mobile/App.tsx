import { useState, useEffect, useCallback, useRef } from 'react'
import { useConnectionStore } from './stores/connection-store'
import { useTaskStore } from './stores/task-store'
import { useAgentStore } from './stores/agent-store'
import { TaskListPage } from './pages/TaskListPage'
import { TaskDetailPage } from './pages/TaskDetailPage'
import { ConversationPage } from './pages/ConversationPage'
import { RepoSelectorPage } from './pages/RepoSelectorPage'
import { TaskFormPage } from './pages/TaskFormPage'
import { SkillSelectorPage } from './pages/SkillSelectorPage'
import { SettingsPage } from './pages/SettingsPage'
import { PairPage } from './pages/PairPage'
import { getPairCodeFromUrl, hasSessionToken } from './api/auth'
import { captureAnalyticsEvent, capturePageView } from '@/lib/analytics'

export type Route =
  | { page: 'list' }
  | { page: 'detail'; taskId: string }
  | { page: 'conversation'; taskId: string }
  | { page: 'repos'; taskId: string }
  | { page: 'skills'; taskId: string }
  | { page: 'create' }
  | { page: 'edit'; taskId: string }
  | { page: 'settings' }

export function App() {
  const pairCode = getPairCodeFromUrl()
  const [paired, setPaired] = useState(() => !pairCode && hasSessionToken())
  const [route, setRoute] = useState<Route>({ page: 'list' })
  const isPopRef = useRef(false)

  // Navigation that pushes browser history so back button works
  const navigate = useCallback((next: Route) => {
    setRoute(next)
    captureAnalyticsEvent('mobile_route_selected', {
      page: next.page,
      task_id: 'taskId' in next ? next.taskId : undefined
    })
    if (!isPopRef.current) {
      history.pushState(next, '', null)
    }
  }, [])

  // Handle browser/system back button
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      isPopRef.current = true
      setRoute((e.state as Route) || { page: 'list' })
      const next = (e.state as Route) || { page: 'list' }
      captureAnalyticsEvent('mobile_route_selected', {
        page: next.page,
        task_id: 'taskId' in next ? next.taskId : undefined,
        source: 'history'
      })
      isPopRef.current = false
    }
    // Seed initial history entry
    history.replaceState({ page: 'list' }, '', null)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const connect = useConnectionStore((s) => s.connect)
  const connected = useConnectionStore((s) => s.connected)
  const setOnReconnect = useConnectionStore((s) => s.setOnReconnect)
  const setOnFirstConnect = useConnectionStore((s) => s.setOnFirstConnect)
  const setOnVisibilityReconnect = useConnectionStore((s) => s.setOnVisibilityReconnect)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const fetchAgents = useAgentStore((s) => s.fetchAgents)
  const fetchSkills = useAgentStore((s) => s.fetchSkills)
  const syncActiveSessions = useAgentStore((s) => s.syncActiveSessions)

  useEffect(() => {
    connect()
    fetchTasks()
    fetchAgents()
    fetchSkills()

    // Sync active sessions once WebSocket is connected (event-driven, not arbitrary delay)
    setOnFirstConnect(() => {
      syncActiveSessions()
    })

    // Re-sync state after WebSocket reconnects to recover missed events
    setOnReconnect(() => {
      fetchTasks()
      syncActiveSessions()
    })

    // Re-sync when page becomes visible (phone wakes) even if connection stayed alive,
    // because messages may have been missed while JS was suspended on mobile
    setOnVisibilityReconnect(() => {
      syncActiveSessions()
    })
  }, [connect, fetchTasks, fetchAgents, fetchSkills, syncActiveSessions, setOnReconnect, setOnFirstConnect, setOnVisibilityReconnect])

  useEffect(() => {
    capturePageView(route.page, {
      route_page: route.page,
      task_id: 'taskId' in route ? route.taskId : undefined,
      paired
    })
  }, [route, paired])

  // Poll tasks every 10s as a fallback
  useEffect(() => {
    const timer = setInterval(() => fetchTasks(), 10_000)
    return () => clearInterval(timer)
  }, [fetchTasks])

  // Show pairing flow if QR code scanned or no session
  if (pairCode && !paired) {
    return <PairPage pairCode={pairCode} onPaired={() => setPaired(true)} />
  }

  if (!paired) {
    return (
      <div className="h-full flex items-center justify-center bg-background p-6">
        <div className="text-center space-y-4 max-w-xs">
          <div className="text-5xl">📱</div>
          <h2 className="font-semibold text-foreground">Not Connected</h2>
          <p className="text-sm text-muted-foreground">
            Open 20x on your desktop, go to Settings → Connect Phone, and scan the QR code.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Connection indicator */}
      {!connected && (
        <div className="bg-amber-500/20 text-amber-300 text-xs text-center py-1 px-2 shrink-0">
          Connecting...
        </div>
      )}

      {route.page === 'list' && (
        <TaskListPage onNavigate={navigate} />
      )}
      {route.page === 'detail' && (
        <TaskDetailPage taskId={route.taskId} onNavigate={navigate} />
      )}
      {route.page === 'conversation' && (
        <ConversationPage taskId={route.taskId} onNavigate={navigate} />
      )}
      {route.page === 'repos' && (
        <RepoSelectorPage taskId={route.taskId} onNavigate={navigate} />
      )}
      {route.page === 'skills' && (
        <SkillSelectorPage taskId={route.taskId} onNavigate={navigate} />
      )}
      {route.page === 'create' && (
        <TaskFormPage onNavigate={navigate} />
      )}
      {route.page === 'edit' && (
        <TaskFormPage taskId={route.taskId} onNavigate={navigate} />
      )}
      {route.page === 'settings' && (
        <SettingsPage onNavigate={navigate} />
      )}
    </div>
  )
}
