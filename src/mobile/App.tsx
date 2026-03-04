import { useState, useEffect, useCallback, useRef } from 'react'
import { useConnectionStore } from './stores/connection-store'
import { useTaskStore } from './stores/task-store'
import { useAgentStore } from './stores/agent-store'
import { TaskListPage } from './pages/TaskListPage'
import { TaskDetailPage } from './pages/TaskDetailPage'
import { ConversationPage } from './pages/ConversationPage'
import { RepoSelectorPage } from './pages/RepoSelectorPage'
import { TaskFormPage } from './pages/TaskFormPage'

export type Route =
  | { page: 'list' }
  | { page: 'detail'; taskId: string }
  | { page: 'conversation'; taskId: string }
  | { page: 'repos'; taskId: string }
  | { page: 'create' }
  | { page: 'edit'; taskId: string }

export function App() {
  const [route, setRoute] = useState<Route>({ page: 'list' })
  const isPopRef = useRef(false)

  // Navigation that pushes browser history so back button works
  const navigate = useCallback((next: Route) => {
    setRoute(next)
    if (!isPopRef.current) {
      history.pushState(next, '', null)
    }
  }, [])

  // Handle browser/system back button
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      isPopRef.current = true
      setRoute((e.state as Route) || { page: 'list' })
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
  }, [connect, fetchTasks, fetchAgents, fetchSkills, syncActiveSessions, setOnReconnect, setOnFirstConnect])

  // Poll tasks every 10s as a fallback
  useEffect(() => {
    const timer = setInterval(() => fetchTasks(), 10_000)
    return () => clearInterval(timer)
  }, [fetchTasks])

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
      {route.page === 'create' && (
        <TaskFormPage onNavigate={navigate} />
      )}
      {route.page === 'edit' && (
        <TaskFormPage taskId={route.taskId} onNavigate={navigate} />
      )}
    </div>
  )
}
