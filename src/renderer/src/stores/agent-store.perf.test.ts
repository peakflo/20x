/**
 * Renderer-side cost of the transcript store for long conversations.
 *
 * Measures what the renderer does per streamed delta and per task switch, with
 * the IPC layer replaced by in-memory mocks (so IPC and main-process query time
 * are NOT included here; they are measured separately in the PR description).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { useAgentStore, __clearProjectionsForTest } from './agent-store'
import type { TranscriptChangedEvent, TranscriptPartRecord } from '@/types/electron'

vi.mock('@/lib/analytics', () => ({
  captureAnalyticsEvent: vi.fn()
}))

const electronAPI = window.electronAPI
const transcriptCb = (electronAPI.onTranscriptChanged as unknown as Mock).mock.calls[0][0] as (e: TranscriptChangedEvent) => void
const getSnapshotMock = electronAPI.agentSession.getTranscriptSnapshot as unknown as Mock
const getDeltaMock = electronAPI.agentSession.getTranscriptDelta as unknown as Mock

const BASE = 1_750_000_000_000
function makeTranscript(taskId: string, count: number): TranscriptPartRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const isTool = i % 2 === 1
    return {
      taskId,
      partId: `${taskId}-p${i}`,
      seq: i + 1,
      role: isTool ? 'assistant' : 'user',
      content: isTool ? '' : `Message ${i} `.repeat(20),
      partType: isTool ? 'tool' : 'text',
      tool: isTool
        ? { name: 'Bash', status: 'completed', input: JSON.stringify({ command: `ls ${i}` }), output: 'x'.repeat(400) }
        : undefined,
      createdAt: BASE + i * 1000,
      updatedAt: BASE + i * 1000,
      rev: i + 1
    }
  })
}

/** Resolves once the store's messages for `taskId` reach `length`; returns ms since `start`. */
function waitForMessages(taskId: string, length: number, start = performance.now()): Promise<number> {
  return new Promise((resolve) => {
    const check = (): void => {
      const messages = useAgentStore.getState().sessions.get(taskId)?.messages
      if (messages && messages.length === length) {
        unsubscribe()
        resolve(performance.now() - start)
      }
    }
    const unsubscribe = useAgentStore.subscribe(check)
    check()
  })
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const report: Record<string, string | number> = {}

beforeEach(() => {
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  __clearProjectionsForTest()
  vi.clearAllMocks()
  getDeltaMock.mockResolvedValue({ parts: [], maxRev: 0 })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('agent-store long-transcript benchmark', () => {
  it('applies one streamed part update to a 5,000-part transcript', async () => {
    const parts = makeTranscript('task-stream', 5000)
    getSnapshotMock.mockResolvedValue(parts)
    const release = useAgentStore.getState().bindTranscript('task-stream')
    await waitForMessages('task-stream', 5000)

    const times: number[] = []
    for (let i = 0; i < 30; i += 1) {
      const streamed = { ...parts[parts.length - 1], content: `streamed ${i} `.repeat(50), rev: 5001 + i }
      const start = performance.now()
      transcriptCb({ taskId: 'task-stream', parts: [streamed], maxRev: 5001 + i })
      times.push(performance.now() - start)
    }
    report['store: streamed delta into 5k-part transcript (median ms)'] = +median(times).toFixed(3)
    expect(useAgentStore.getState().sessions.get('task-stream')?.messages.length).toBe(5000)
    release()
  })

  it('switches back to a recently viewed 5,000-part task', async () => {
    const taskA = makeTranscript('task-a', 5000)
    const taskB = makeTranscript('task-b', 5000)
    getSnapshotMock.mockImplementation(async (taskId: string) => (taskId === 'task-a' ? taskA : taskB))

    const times: number[] = []
    let releaseCurrent = useAgentStore.getState().bindTranscript('task-a')
    await waitForMessages('task-a', 5000)
    for (let i = 0; i < 6; i += 1) {
      const next = i % 2 === 0 ? 'task-b' : 'task-a'
      releaseCurrent()
      // Timed from the bind call, so synchronous commits are included. Only the
      // switch back to task A is recorded; B is the "other" task the user visits.
      const start = performance.now()
      releaseCurrent = useAgentStore.getState().bindTranscript(next)
      const elapsed = await waitForMessages(next, 5000, start)
      if (next === 'task-a') times.push(elapsed)
    }
    releaseCurrent()
    report['store: switch back to 5k-part task (median ms, renderer only)'] = +median(times).toFixed(2)
    expect(times.length).toBe(3)
  })

  it('reports the store benchmark table', () => {
    console.info('\n[perf] agent-store benchmark\n' + Object.entries(report).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
  })
})
