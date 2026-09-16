import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRecordingManifest } from '@shared/browser-recording'
import { notifyAgentsOfBrowserRecording, sendBrowserMessage } from './browser-agent-notifications'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { sessionId: string; agentId: string }>(),
  tasks: [] as { id: string; agent_id: string; session_id?: string }[],
  send: vi.fn(), start: vi.fn(), resume: vi.fn(),
}))
vi.mock('@/stores/agent-store', () => ({ useAgentStore: { getState: () => ({
  getSession: (taskId: string) => mocks.sessions.get(taskId),
  initSession: (taskId: string, sessionId: string, agentId: string) => mocks.sessions.set(taskId, { sessionId, agentId }),
}) } }))
vi.mock('@/stores/task-store', () => ({ useTaskStore: { getState: () => ({ tasks: mocks.tasks }) } }))
vi.mock('./ipc-client', () => ({ agentSessionApi: { send: mocks.send, start: mocks.start, resume: mocks.resume } }))

const recording = { id: 'recording-1', title: 'Portal', taskIds: ['a', 'a', 'b'] } as BrowserRecordingManifest

describe('browser recording notification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recording.id = `recording-${Math.random()}`
    mocks.sessions.clear()
    mocks.tasks = []
    mocks.send.mockResolvedValue({ success: true })
    mocks.start.mockResolvedValue({ sessionId: 'started' })
    mocks.resume.mockResolvedValue({ sessionId: 'resumed' })
  })

  it('notifies each distinct connected task and includes durable reading tools', async () => {
    for (const taskId of ['a', 'b']) mocks.sessions.set(taskId, { sessionId: taskId, agentId: 'agent' })
    expect(await notifyAgentsOfBrowserRecording(recording)).toEqual({ notified: ['a', 'b'], failed: [] })
    await notifyAgentsOfBrowserRecording(recording)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    const message = mocks.send.mock.calls[0][1]
    expect(message).toContain(`browser_recording_get {"task_id":"a","recording_id":"${recording.id}"}`)
    expect(message).toContain('browser_recording_steps')
    expect(message).toContain('browser_recording_snapshot')
  })

  it('saves without a message when no task is connected', async () => {
    expect(await notifyAgentsOfBrowserRecording(recording, [])).toEqual({ notified: [], failed: [] })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('resumes ended sessions and starts only once for concurrent messages', async () => {
    mocks.tasks = [{ id: 'a', agent_id: 'agent', session_id: 'old' }]
    mocks.resume.mockResolvedValue({ ended: true })
    await Promise.all([sendBrowserMessage('a', 'connection'), sendBrowserMessage('a', 'recording')])
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.resume).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls.map((call) => call[1])).toEqual(['connection', 'recording'])
  })

  it('keeps failed recipients separate so retry does not duplicate delivered messages', async () => {
    mocks.sessions.set('a', { sessionId: 'a', agentId: 'agent' })
    expect(await notifyAgentsOfBrowserRecording(recording)).toEqual({ notified: ['a'], failed: ['b'] })
    mocks.tasks = [{ id: 'b', agent_id: 'agent' }]
    expect(await notifyAgentsOfBrowserRecording(recording, ['b'])).toEqual({ notified: ['b'], failed: [] })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })
})
