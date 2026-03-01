/**
 * HTTP API client for the mobile API server.
 * In production the SPA is served by the mobile-api-server (same origin).
 * In dev mode (Vite on a different port), we point directly at the Electron server.
 */

const MOBILE_API_PORT = '20620'
const BASE =
  typeof window !== 'undefined' && window.location.port !== MOBILE_API_PORT
    ? `http://${window.location.hostname}:${MOBILE_API_PORT}`
    : ''

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || res.statusText)
  }
  return res.json()
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    get: (id: string) => get<unknown>(`/api/tasks/${id}`),
    update: (id: string, data: unknown) => post<unknown>(`/api/tasks/${id}`, data)
  },
  agents: {
    list: () => get<unknown[]>('/api/agents'),
    get: (id: string) => get<unknown>(`/api/agents/${id}`)
  },
  skills: {
    list: () => get<unknown[]>('/api/skills')
  },
  github: {
    getOrg: () => get<{ org: string }>('/api/github/org'),
    fetchRepos: (org: string) =>
      post<Array<{ name: string; fullName: string; defaultBranch: string; cloneUrl: string; description: string; isPrivate: boolean }>>('/api/github/repos', { org })
  },
  sessions: {
    list: () => get<unknown[]>('/api/sessions'),
    start: (agentId: string, taskId: string, skipInitialPrompt?: boolean) =>
      post<{ sessionId: string }>('/api/sessions/start', { agentId, taskId, skipInitialPrompt }),
    resume: (sessionId: string, agentId: string, taskId: string) =>
      post<{ sessionId: string }>(`/api/sessions/${sessionId}/resume`, { agentId, taskId }),
    send: (sessionId: string, message: string, taskId?: string, agentId?: string) =>
      post<{ success: boolean; newSessionId?: string }>(`/api/sessions/${sessionId}/send`, { message, taskId, agentId }),
    approve: (sessionId: string, approved: boolean, message?: string) =>
      post<{ success: boolean }>(`/api/sessions/${sessionId}/approve`, { approved, message }),
    sync: (sessionId: string) =>
      post<{ success: boolean; status: string }>(`/api/sessions/${sessionId}/sync`),
    abort: (sessionId: string) =>
      post<{ success: boolean }>(`/api/sessions/${sessionId}/abort`),
    stop: (sessionId: string) =>
      post<{ success: boolean }>(`/api/sessions/${sessionId}/stop`)
  }
}
