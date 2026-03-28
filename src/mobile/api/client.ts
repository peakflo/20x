/**
 * HTTP API client for the mobile API server.
 * In production the SPA is served by the mobile-api-server (same origin).
 * In dev mode (Vite on a different port), we point directly at the Electron server.
 */
import { getAuthToken } from './auth'

const MOBILE_API_PORT = '20620'
const BASE =
  typeof window !== 'undefined' && window.location.port !== MOBILE_API_PORT
    ? `http://${window.location.hostname}:${MOBILE_API_PORT}`
    : ''

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getAuthToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || res.statusText)
  }
  return res.json()
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(data.error || res.statusText)
  }
  return res.json()
}

export const api = {
  tasks: {
    list: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      return get<unknown[]>(`/api/tasks${qs}`)
    },
    get: (id: string) => get<unknown>(`/api/tasks/${encodeURIComponent(id)}`),
    create: (data: unknown) => post<unknown>('/api/tasks', data),
    update: (id: string, data: unknown) => post<unknown>(`/api/tasks/${encodeURIComponent(id)}`, data),
    reorderSubtasks: (parentId: string, orderedIds: string[]) =>
      post<{ success: boolean }>('/api/tasks/reorder-subtasks', { parentId, orderedIds })
  },
  taskSources: {
    list: () => get<unknown[]>('/api/task-sources'),
    create: (data: { name: string; plugin_id: string; config: Record<string, unknown>; mcp_server_id?: string | null }) =>
      post<unknown>('/api/task-sources', data),
    update: (id: string, data: unknown) => post<unknown>(`/api/task-sources/${encodeURIComponent(id)}`, data),
    sync: (id: string) => post<unknown>(`/api/task-sources/${encodeURIComponent(id)}/sync`),
    syncAll: () => post<unknown[]>('/api/task-sources/sync-all')
  },
  plugins: {
    list: () => get<Array<{ id: string; displayName: string; description: string; icon: string; requiresMcpServer: boolean }>>('/api/plugins'),
    getSchema: (pluginId: string) => get<unknown[]>(`/api/plugins/${encodeURIComponent(pluginId)}/schema`),
    getDocumentation: (pluginId: string) => get<{ documentation: string | null }>(`/api/plugins/${encodeURIComponent(pluginId)}/documentation`),
    resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>) =>
      post<Array<{ value: string; label: string }>>(`/api/plugins/${encodeURIComponent(pluginId)}/resolve-options`, { resolverKey, config })
  },
  agents: {
    list: () => get<unknown[]>('/api/agents'),
    get: (id: string) => get<unknown>(`/api/agents/${encodeURIComponent(id)}`)
  },
  skills: {
    list: () => get<unknown[]>('/api/skills')
  },
  git: {
    getProvider: () => get<{ provider: string }>('/api/git/provider')
  },
  github: {
    getOrg: () => get<{ org: string }>('/api/github/org'),
    getOrgs: () => get<Array<{ value: string; label: string }>>('/api/github/orgs'),
    setOrg: (org: string) => post<{ org: string }>('/api/github/org', { org }),
    fetchRepos: (org: string) =>
      post<Array<{ name: string; fullName: string; defaultBranch: string; cloneUrl: string; description: string; isPrivate: boolean }>>('/api/github/repos', { org })
  },
  sessions: {
    list: () => get<unknown[]>('/api/sessions'),
    start: (agentId: string, taskId: string, skipInitialPrompt?: boolean) =>
      post<{ sessionId: string }>('/api/sessions/start', { agentId, taskId, skipInitialPrompt }),
    resume: (sessionId: string, agentId: string, taskId: string) =>
      post<{ sessionId: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, { agentId, taskId }),
    send: (sessionId: string, message: string, taskId?: string, agentId?: string) =>
      post<{ success: boolean; newSessionId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/send`, { message, taskId, agentId }),
    approve: (sessionId: string, approved: boolean, message?: string) =>
      post<{ success: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/approve`, { approved, message }),
    sync: (sessionId: string) =>
      post<{ success: boolean; status: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/sync`),
    abort: (sessionId: string) =>
      post<{ success: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`),
    stop: (sessionId: string) =>
      post<{ success: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`)
  }
}
