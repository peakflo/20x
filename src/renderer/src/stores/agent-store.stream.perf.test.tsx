/**
 * Renderer cost per streamed `transcript:changed` event: receive + store apply,
 * and the React commit of the REAL AgentTranscriptPanel bound to the store.
 *
 * A short transcript is followed by an answer that grows by 200 bytes per
 * event (one 125 ms flush of two 100-byte polls) to 20 KB and to 100 KB.
 *
 *  - receive + apply ms: `structuredClone(event)` (stand-in for the IPC
 *    deserialize on the renderer thread; Electron uses the same algorithm) plus
 *    the store's `transcript:changed` handler, synchronously.
 *  - commit ms: React Profiler `actualDuration` of the commit that follows.
 *
 * happy-dom has no layout; rows get fixed heights so the virtualizer renders a
 * realistic window (same approach as AgentTranscriptPanel.perf.test.tsx).
 * Numbers are medians over the last 20 events (answer at full size).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus, __clearProjectionsForTest, type AgentMessage } from './agent-store'
import type { TranscriptChangedEvent } from '@/types/electron'
import { FakeTranscriptServer } from '@shared/transcript-stream.testing'

vi.mock('@/lib/analytics', () => ({ captureAnalyticsEvent: vi.fn() }))

const VIEWPORT_PX = 600
const ROW_PX = 80
const originalRect = Element.prototype.getBoundingClientRect
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
const heightOf = (el: Element): number => (el.classList.contains('overflow-y-auto') ? VIEWPORT_PX : ROW_PX)

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    const h = heightOf(this)
    return { x: 0, y: 0, top: 0, left: 0, bottom: h, right: 800, width: 800, height: h, toJSON: () => ({}) } as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return heightOf(this) } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return heightOf(this) } })
})

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect
  for (const [name, d] of [['offsetHeight', originalOffsetHeight], ['clientHeight', originalClientHeight]] as const) {
    if (d) Object.defineProperty(HTMLElement.prototype, name, d)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

const transcriptCb = (window.electronAPI.onTranscriptChanged as unknown as Mock).mock.calls[0][0] as (e: TranscriptChangedEvent) => void
const getSyncMock = window.electronAPI.agentSession.getTranscriptSync as unknown as Mock
const EMPTY: AgentMessage[] = []

function Live({ taskId }: { taskId: string }) {
  const messages = useAgentStore((s) => s.sessions.get(taskId)?.messages ?? EMPTY)
  return (
    <AgentTranscriptPanel messages={messages} status={SessionStatus.WORKING} onStop={() => undefined} taskId={taskId} sessionId="s1" agentId="agent-1" />
  )
}

const SENTENCE = 'The agent checked the cache path and found the stale entry in the index. ' // 74 bytes
function chunk(i: number): string {
  // 100 bytes per poll; a paragraph break every 5 polls so finished blocks memoize.
  const body = (SENTENCE + `step ${i} `).padEnd(98, '.')
  return i % 5 === 4 ? `${body}\n\n` : `${body}  `
}

const HISTORY = 6
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const report: Record<string, number> = {}

async function run(answerKB: number): Promise<{ applyMs: number; commitMs: number; bytes: number }> {
  __clearProjectionsForTest()
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  const taskId = `task-${answerKB}`
  const server = new FakeTranscriptServer()
  getSyncMock.mockImplementation(async (id: string, sinceRev?: number) => server.sync(id, sinceRev))
  // History: a few messages, alternating prose and tool calls, short enough
  // that the live answer is inside the virtualized window (happy-dom does not
  // scroll the list to the bottom).
  for (let i = 0; i < HISTORY; i++) {
    server.write(taskId, [i % 2
      ? { partId: `h${i}`, partType: 'tool', content: '', tool: { name: 'Bash', status: 'completed', input: `{"command":"ls ${i}"}`, output: 'line\n'.repeat(20) } }
      : { partId: `h${i}`, role: i % 4 === 0 ? 'user' : 'assistant', content: `${SENTENCE}\n\n- item ${i}\n` }])
  }

  const commits: number[] = []
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => { commits.push(actualDuration) }
  useAgentStore.getState().initSession(taskId, 's1', 'agent-1')
  await act(async () => { await useAgentStore.getState().hydrateTranscript(taskId) })
  render(<Profiler id="t" onRender={onRender}><Live taskId={taskId} /></Profiler>)

  const events = answerKB * 5 // 200 bytes per event
  const applyTimes: number[] = []
  const commitTimes: number[] = []
  let text = ''
  let bytes = 0
  for (let e = 0; e < events; e++) {
    text += chunk(2 * e) + chunk(2 * e + 1)
    const event = server.write(taskId, [{ partId: 'answer', content: text }]) as TranscriptChangedEvent
    bytes += JSON.stringify(event).length
    const before = commits.length
    let applyMs = 0
    act(() => {
      const t0 = performance.now()
      transcriptCb(structuredClone(event))
      applyMs = performance.now() - t0
    })
    if (e >= events - 20) {
      applyTimes.push(applyMs)
      if (commits.length > before) commitTimes.push(commits[commits.length - 1])
    }
  }
  const messages = useAgentStore.getState().sessions.get(taskId)!.messages
  expect(messages[messages.length - 1].content).toBe(text)
  // The live answer must be inside the virtualized window, or the commit would
  // not include rendering it.
  expect(document.body.textContent?.includes(`step ${2 * events - 1}`)).toBe(true)
  cleanup()
  return { applyMs: median(applyTimes), commitMs: median(commitTimes), bytes }
}

describe('transcript:changed renderer cost per streamed event', () => {
  for (const kb of [20, 100]) {
    it(`streams a ${kb} KB answer`, async () => {
      const r = await run(kb)
      report[`${kb} KB answer: receive + store apply per event (median ms, last 20)`] = +r.applyMs.toFixed(3)
      report[`${kb} KB answer: React commit per event (median ms, last 20)`] = +r.commitMs.toFixed(2)
      report[`${kb} KB answer: event bytes total (KB)`] = +(r.bytes / 1024).toFixed(1)
    }, 120_000)
  }

  it('reports the table', () => {
    console.info('\n[perf] transcript:changed renderer cost\n' + Object.entries(report).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
  })
})
