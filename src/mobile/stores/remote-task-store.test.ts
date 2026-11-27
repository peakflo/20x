import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, remoteState } = vi.hoisted(() => ({ handlers: new Map<string, (p: unknown) => void>(), remoteState: vi.fn() }))
vi.mock('../api/websocket', () => ({ onEvent: (t: string, fn: (p: unknown) => void) => { handlers.set(t, fn); return () => {} } }))
vi.mock('../api/client', () => ({ api: { tasks: { remoteState: (id: string) => remoteState(id) } } }))

import { useRemoteTaskStore } from './remote-task-store'

beforeEach(() => { useRemoteTaskStore.setState({ states: {} }); remoteState.mockReset() })

describe('remote-task-store', () => {
  it('updates from the enterprise-runners:task-state websocket event', () => {
    const state = { taskId: 't1', sync: 'runner-offline' }
    handlers.get('enterprise-runners:task-state')!({ taskId: 't1', state })
    expect(useRemoteTaskStore.getState().states.t1).toEqual(state)
  })
  it('loads via REST and treats null as a local task', async () => {
    remoteState.mockResolvedValueOnce({ taskId: 't2', sync: 'live' })
    await useRemoteTaskStore.getState().load('t2')
    expect(useRemoteTaskStore.getState().states.t2.sync).toBe('live')
    remoteState.mockResolvedValueOnce(null)
    await useRemoteTaskStore.getState().load('t2')
    expect(useRemoteTaskStore.getState().states.t2).toBeUndefined()
  })
})
