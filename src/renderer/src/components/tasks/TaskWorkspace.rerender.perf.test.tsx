/**
 * Cost of one TaskWorkspace re-render that its parent forces with a changed
 * callback identity (what AppLayout did on every `task:updated` for ANY task,
 * via an inline `onBack={() => selectTask(null)}`).
 *
 * Runs the REAL TaskWorkspace and the REAL transcript panel/virtualizer with a
 * 500-part transcript under happy-dom (fixed layout stubs). Commit time comes
 * from React's Profiler (`actualDuration`), median of N. Printed only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Profiler, type ReactElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { Mock } from 'vitest'
import { TaskWorkspace } from './TaskWorkspace'
import { useAgentStore, __clearProjectionsForTest } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { Agent, WorkfloTask } from '@/types'
import type { TranscriptPartRecord } from '@/types/electron'

const api = window.electronAPI as unknown as Record<string, unknown>
if (!api.onGithubDeviceCode) api.onGithubDeviceCode = vi.fn(() => vi.fn())
if (!api.onHeartbeatAlert) api.onHeartbeatAlert = vi.fn(() => vi.fn())
if (!api.onHeartbeatDisabled) api.onHeartbeatDisabled = vi.fn(() => vi.fn())
if (!api.tasks) api.tasks = { getWorkspaceDir: vi.fn().mockResolvedValue('/tmp') }
if (!api.artifacts) api.artifacts = { scan: vi.fn().mockResolvedValue([]), read: vi.fn().mockResolvedValue(null) }

const VIEWPORT_PX = 600
const ROW_PX = 80
const originalRect = Element.prototype.getBoundingClientRect
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
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  cleanup()
})

const task = {
  id: 'task-1', title: 'Perf task', description: 'A task with a long transcript', type: 'general', priority: 'medium',
  status: TaskStatus.ReadyForReview, assignee: '', due_date: null, labels: [], attachments: [], repos: [], output_fields: [],
  agent_id: 'agent-1', session_id: 'sess-1', external_id: null, source_id: null, source: 'manual', skill_ids: null,
  snoozed_until: null, resolution: null, feedback_rating: null, feedback_comment: null, is_recurring: false,
  recurrence_pattern: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null,
  auto_start_agent: false, auto_complete_without_review: false, complete_at_source: null, review_entered_at: null,
  review_seen_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', parent_task_id: null, sort_order: 0
} as unknown as WorkfloTask
const agents = [{ id: 'agent-1', name: 'Agent', server_url: '', config: {}, is_default: true, created_at: '', updated_at: '' }] as unknown as Agent[]

function transcript(count: number): TranscriptPartRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const isTool = i % 2 === 1
    return {
      taskId: 'task-1', partId: `p${i}`, seq: i + 1, role: isTool ? 'assistant' : (i % 4 === 0 ? 'user' : 'assistant'),
      content: isTool ? '' : `Message ${i} with **markdown** and \`code\`. `.repeat(6),
      partType: isTool ? 'tool' : 'text',
      tool: isTool ? { name: 'Bash', status: 'completed', input: JSON.stringify({ command: `ls ${i}` }), output: 'out\n'.repeat(10) } : undefined,
      createdAt: 1_750_000_000_000 + i * 1000, updatedAt: 1_750_000_000_000 + i * 1000, rev: i + 1
    }
  })
}

const noop = (): void => {}
const noopAsync = async (): Promise<void> => {}

describe('TaskWorkspace forced re-render cost', () => {
  it('measures one parent-forced re-render with a 500-part transcript', async () => {
    __clearProjectionsForTest()
    useAgentStore.setState({ agents, sessions: new Map() })
    ;(window.electronAPI.agentSession.getTranscriptSnapshot as unknown as Mock).mockResolvedValue(transcript(500))
    ;(window.electronAPI.agentSession.getTranscriptDelta as unknown as Mock).mockResolvedValue({ parts: [], maxRev: 500 })

    const durations: number[] = []
    let record = false
    const tree = (onBack: () => void): ReactElement => (
      <Profiler id="ws" onRender={(_id, _phase, d) => { if (record) durations.push(d) }}>
        <TaskWorkspace task={task} agents={agents} onEdit={noop} onDelete={noop} onUpdateAttachments={noop}
          onUpdateOutputFields={noop} onCompleteTask={noop} onAssignAgent={noopAsync} onUpdateTask={noopAsync} onBack={onBack} />
      </Profiler>
    )
    const view = render(tree(() => {}))
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(useAgentStore.getState().sessions.get('task-1')?.messages.length ?? 0).toBeGreaterThan(0)

    const RUNS = 25
    record = true
    for (let i = 0; i < RUNS; i++) act(() => { view.rerender(tree(() => {})) })
    const sorted = [...durations].sort((a, b) => a - b)
    console.log(`[perf] TaskWorkspace forced re-render (500-part transcript): median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms over ${durations.length} commits`)
  })
})
