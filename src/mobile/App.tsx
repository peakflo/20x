import { useState, useEffect } from 'react'
import { useConnectionStore } from './stores/connection-store'
import { useTaskStore } from './stores/task-store'
import { useAgentStore } from './stores/agent-store'
import { TaskListPage } from './pages/TaskListPage'
import { TaskDetailPage } from './pages/TaskDetailPage'
import { ConversationPage } from './pages/ConversationPage'
import { RepoSelectorPage } from './pages/RepoSelectorPage'

export type Route =
  | { page: 'list' }
  | { page: 'detail'; taskId: string }
  | { page: 'conversation'; taskId: string }
  | { page: 'repos'; taskId: string }

export function App() {
  const [route, setRoute] = useState<Route>({ page: 'list' })
  const connect = useConnectionStore((s) => s.connect)
  const connected = useConnectionStore((s) => s.connected)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const fetchAgents = useAgentStore((s) => s.fetchAgents)
  const fetchSkills = useAgentStore((s) => s.fetchSkills)
  const syncActiveSessions = useAgentStore((s) => s.syncActiveSessions)

  useEffect(() => {
    connect()
    fetchTasks()
    fetchAgents()
    fetchSkills()
    // After WebSocket connects and agents load, sync with any running sessions
    const timer = setTimeout(() => syncActiveSessions(), 500)
    return () => clearTimeout(timer)
  }, [connect, fetchTasks, fetchAgents, syncActiveSessions])

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
        <TaskListPage onNavigate={setRoute} />
      )}
      {route.page === 'detail' && (
        <TaskDetailPage taskId={route.taskId} onNavigate={setRoute} />
      )}
      {route.page === 'conversation' && (
        <ConversationPage taskId={route.taskId} onNavigate={setRoute} />
      )}
      {route.page === 'repos' && (
        <RepoSelectorPage taskId={route.taskId} onNavigate={setRoute} />
      )}
    </div>
  )
}
