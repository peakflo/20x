import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { TaskList, TASK_LIST_VIRTUALIZE_THRESHOLD } from './TaskList'

function makeTasks(count: number): WorkfloTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    status: TaskStatus.NotStarted,
    created_at: new Date(1_750_000_000_000 + i).toISOString(),
    updated_at: new Date(1_750_000_000_000 + i).toISOString(),
    labels: [],
    attachments: [],
    repos: [],
    output_fields: []
  }) as unknown as WorkfloTask)
}

function renderInScroller(tasks: WorkfloTask[], onSelect = vi.fn()) {
  return render(
    <div style={{ height: 400, overflowY: 'auto' }}>
      <TaskList tasks={tasks} selectedTaskId={null} onSelectTask={onSelect} />
    </div>
  )
}

function stubLayout(): void {
  // jsdom has no layout; give the scroller a viewport and rows a height.
  const height = (el: Element): number => ((el as HTMLElement).style?.overflowY === 'auto' ? 400 : 38)
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const h = height(this)
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: h, width: 300, height: h, toJSON: () => ({}) } as DOMRect
  })
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return height(this) })
  const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return height(this) })
  onTestFinished(() => { rect.mockRestore(); offset.mockRestore(); client.mockRestore() })
}

afterEach(cleanup)

describe('TaskList', () => {
  it('renders every row for short lists', () => {
    const onSelect = vi.fn()
    renderInScroller(makeTasks(10), onSelect)
    expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(10)
    fireEvent.click(screen.getByText('Task 3'))
    expect(onSelect).toHaveBeenCalledWith('t3')
  })

  it('mounts only a window of rows for long lists', () => {
    stubLayout()
    const count = TASK_LIST_VIRTUALIZE_THRESHOLD * 5
    renderInScroller(makeTasks(count))
    const rendered = screen.queryAllByText(/^Task \d+$/).length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(count)
  })

  it('keeps virtual mode and scroll position when a section is expanded', () => {
    stubLayout()
    const tasks = makeTasks(TASK_LIST_VIRTUALIZE_THRESHOLD + 20).map((task, i) =>
      i >= 10 ? ({ ...task, status: TaskStatus.Completed }) as WorkfloTask : task)
    const { container } = renderInScroller(tasks)
    const scroller = container.firstElementChild as HTMLElement
    // Only 10 active rows + 1 header are visible, but the mode is chosen by
    // task count, so the list is already virtual before the toggle.
    expect(container.querySelector('[data-index]')).not.toBeNull()
    scroller.scrollTop = 120
    fireEvent.click(screen.getByText('Completed'))
    expect(container.querySelector('[data-index]')).not.toBeNull()
    expect(scroller.scrollTop).toBe(120)
    expect(screen.getAllByText(/^Task \d+$/).length).toBeGreaterThan(10)
  })
})
