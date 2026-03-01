/**
 * HTTP API client for the mobile API server.
 * Uses same-origin fetch (mobile SPA is served by the same server).
 */

const BASE = ''

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
    abort: (sessionId: string) =>
      post<{ success: boolean }>(`/api/sessions/${sessionId}/abort`),
    stop: (sessionId: string) =>
      post<{ success: boolean }>(`/api/sessions/${sessionId}/stop`)
  }
}
