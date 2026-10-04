/**
 * Long-transcript render benchmark for the desktop agent transcript.
 *
 * Runs the REAL AgentTranscriptPanel and the REAL @tanstack/react-virtual
 * virtualizer under happy-dom. happy-dom has no layout engine, so the scroll
 * viewport and each row are given fixed heights; that is enough for the
 * virtualizer to compute a realistic window of visible rows.
 *
 * Metrics:
 *  - commit ms: React Profiler `actualDuration` of each commit (median of N)
 *  - row renders: how many transcript rows re-render for one streamed change.
 *    Every compact tool row formats its timestamp during render, so counting
 *    `Date#toLocaleTimeString` calls during a commit is a deterministic proxy
 *    for "how many tool rows re-rendered".
 *  - DOM nodes: size of the mounted tree.
 *
 * Timing numbers are logged for the PR table; the assertions only check
 * deterministic properties (row renders, DOM bounds) so the test is not flaky.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { AgentTranscriptPanel } from './AgentTranscriptPanel'
import { SessionStatus, type AgentMessage } from '@/stores/agent-store'

// Counts the markdown source handed to ReactMarkdown: every render re-parses its
// whole input, so this is the deterministic parse-work metric for streaming.
const markdownWork = vi.hoisted(() => ({ chars: 0 }))
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  const Original = actual.default
  function CountingReactMarkdown(props: { children?: unknown }) {
    markdownWork.chars += String(props.children ?? '').length
    return <Original {...(props as Parameters<typeof Original>[0])} />
  }
  return { ...actual, default: CountingReactMarkdown }
})

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
  restoreProperty('offsetHeight', originalOffsetHeight)
  restoreProperty('clientHeight', originalClientHeight)
})

function restoreProperty(name: 'offsetHeight' | 'clientHeight', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── Synthetic transcript builders ─────────────────────────────

const BASE_TIME = 1_750_000_000_000

function toolMessage(id: string, index: number): AgentMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: new Date(BASE_TIME + index * 1000),
    partType: 'tool',
    tool: {
      name: index % 3 === 0 ? 'Read' : 'Bash',
      status: 'completed',
      input: JSON.stringify({ command: `grep -rn needle_${index} src`, file_path: `src/module-${index % 40}/file.ts` }),
      output: `${'matching line of output\n'.repeat(12)}index ${index}`
    }
  }
}

const PROSE = [
  'The agent reviewed the module and found a **race** in the cache invalidation path.',
  '',
  '- first finding with `inline code`',
  '- second finding with a [link](https://example.com/docs)',
  '',
  '```ts',
  'export const value = 42',
  '```',
  ''
].join('\n')

function textMessage(id: string, index: number, body = PROSE): AgentMessage {
  return {
    id,
    role: index % 5 === 0 ? 'user' : 'assistant',
    content: body,
    timestamp: new Date(BASE_TIME + index * 1000),
    partType: 'text'
  }
}

/** A conversation: prose turns separated by runs of tool calls (like a real agent run). */
function buildTranscript(prefix: string, count: number): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (let i = 0; i < count; i += 1) {
    if (i % 8 === 0) messages.push(textMessage(`${prefix}-text-${i}`, i))
    else messages.push(toolMessage(`${prefix}-tool-${i}`, i))
  }
  return messages
}

// ── Measurement helpers ───────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

interface Commit { ms: number }

function makeProfiler() {
  const commits: Commit[] = []
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    commits.push({ ms: actualDuration })
  }
  return { commits, onRender }
}

function panel(messages: AgentMessage[], taskId: string) {
  return (
    <AgentTranscriptPanel
      messages={messages}
      status={SessionStatus.IDLE}
      onStop={() => undefined}
      taskId={taskId}
      sessionId={null}
      agentId="agent-1"
    />
  )
}

function countTimestampRenders(fn: () => void): number {
  const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString')
  try {
    fn()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

const report: Record<string, string | number> = {}

describe('AgentTranscriptPanel long-transcript benchmark', () => {
  it('mounts a 2,000-message transcript with a bounded DOM', () => {
    const messages = buildTranscript('mount', 2000)
    const { commits, onRender } = makeProfiler()
    const { container } = render(<Profiler id="transcript" onRender={onRender}>{panel(messages, 'task-mount')}</Profiler>)

    const domNodes = container.querySelectorAll('*').length
    report['mount 2k msgs: first commit (ms)'] = +commits[0].ms.toFixed(1)
    report['mount 2k msgs: DOM nodes'] = domNodes
    expect(commits.length).toBeGreaterThan(0)
    // Virtualized: only the viewport window (plus overscan) is in the DOM.
    expect(domNodes).toBeLessThan(2500)
  })

  it('streams text tokens into the last message without re-rendering the transcript', () => {
    // The in-flight message sits at the bottom of the transcript, so it is inside
    // the virtualized window. Its body is about 18 KB of markdown.
    const messages = buildTranscript('stream', 10)
    const longBody = PROSE.repeat(120)
    messages.push(textMessage('stream-live', 11, longBody))
    const { commits, onRender } = makeProfiler()
    const view = render(<Profiler id="transcript" onRender={onRender}>{panel(messages, 'task-stream')}</Profiler>)
    commits.length = 0

    // Each streamed delta: the store replaces only the changed message object.
    const times: number[] = []
    let body = longBody
    const settled = messages.slice(0, -1)
    const parsedChars: number[] = []
    for (let token = 0; token < 20; token += 1) {
      body += 'token '
      const next = [...settled, { ...messages[messages.length - 1], content: body }]
      const before = commits.length
      markdownWork.chars = 0
      act(() => {
        view.rerender(<Profiler id="transcript" onRender={onRender}>{panel(next, 'task-stream')}</Profiler>)
      })
      parsedChars.push(markdownWork.chars)
      if (commits.length > before) times.push(commits[commits.length - 1].ms)
    }
    report['stream token: commits per delta'] = commits.length / 20
    report['stream token: markdown chars parsed per delta (18 KB live message)'] = median(parsedChars)
    report['stream token: median commit (ms, 18 KB live message)'] = +median(times).toFixed(2)
    expect(commits.length).toBe(20)
    // Only the block still being written is re-parsed; the finished blocks are memoized.
    expect(median(parsedChars)).toBeLessThan(2000)
  })

  it('appending one tool call to a 200-call activity group re-renders only the new row', () => {
    // Trailing activity group: 200 consecutive tool calls with no prose in between.
    const base: AgentMessage[] = Array.from({ length: 200 }, (_, i) => toolMessage(`grp-tool-${i}`, i))
    const { commits, onRender } = makeProfiler()
    const view = render(<Profiler id="transcript" onRender={onRender}>{panel(base, 'task-group')}</Profiler>)
    commits.length = 0

    const times: number[] = []
    const rowRenders: number[] = []
    let current = base
    for (let step = 0; step < 10; step += 1) {
      const next = [...current, toolMessage(`grp-new-${step}`, 300 + step)]
      const before = commits.length
      rowRenders.push(countTimestampRenders(() => {
        act(() => {
          view.rerender(<Profiler id="transcript" onRender={onRender}>{panel(next, 'task-group')}</Profiler>)
        })
      }))
      if (commits.length > before) times.push(commits[commits.length - 1].ms)
      current = next
    }
    report['tool append (200-call group): tool rows rendered per new call'] = median(rowRenders)
    report['tool append (200-call group): median commit (ms)'] = +median(times).toFixed(2)
    // Only the newly appended row should render; the 200 untouched rows are memoized.
    expect(median(rowRenders)).toBeLessThanOrEqual(5)
  })

  it('switches between two 2,000-message tasks', () => {
    const taskA = buildTranscript('switch-a', 2000)
    const taskB = buildTranscript('switch-b', 2000)
    const { commits, onRender } = makeProfiler()
    const view = render(<Profiler id="transcript" onRender={onRender}>{panel(taskA, 'task-a')}</Profiler>)
    const times: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const before = commits.length
      const [nextMessages, nextTask] = i % 2 === 0 ? [taskB, 'task-b'] : [taskA, 'task-a']
      act(() => {
        view.rerender(<Profiler id="transcript" onRender={onRender}>{panel(nextMessages, nextTask)}</Profiler>)
      })
      if (commits.length > before) times.push(commits[commits.length - 1].ms)
    }
    report['task switch (2k<->2k msgs): median commit (ms)'] = +median(times).toFixed(2)
    expect(times.length).toBe(10)
  })

  it('reports the benchmark table', () => {
    console.info('\n[perf] AgentTranscriptPanel benchmark\n' + Object.entries(report).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
  })
})
