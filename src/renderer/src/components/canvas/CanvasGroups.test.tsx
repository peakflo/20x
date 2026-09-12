import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { CanvasGroups, CanvasGroupsMenu } from './CanvasGroups'
import { FactoryCanvas } from '../factories/FactoryCanvas'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useUIStore } from '@/stores/ui-store'

const tasks = [{ id: 't1', title: 'Task 1' }, { id: 't2', title: 'Task 2' }]
vi.mock('@/stores/task-store', () => ({ useTaskStore: (selector: (state: { tasks: typeof tasks }) => unknown) => selector({ tasks }) }))
vi.mock('../tasks/TaskGroups', () => ({ GroupControls: () => null }))

describe('CanvasGroups', () => {
  beforeEach(() => {
    useCanvasStore.setState({ panels: [], edges: [], nextZIndex: 1, isLoaded: true, shownGroupIds: [], closedGroupMemberIds: {} })
    useTaskGroupStore.setState({ isLoaded: true, groups: [{ id: 'g1', name: 'Group 1', description: '', projectId: null, createdAt: '' }], membership: { t1: 'g1' }, executions: {}, canvasGroupId: null })
    useUIStore.setState({ canvasResponsibilityId: null, canvasResponsibilityRequest: 0 })
  })
  afterEach(cleanup)

  it('uses live membership for frames and keeps the menu outside the transformed frame tree', async () => {
    useCanvasStore.getState().showGroup('g1', ['t1'])
    render(<><CanvasGroups /><CanvasGroupsMenu /></>)
    await waitFor(() => expect(useCanvasStore.getState().panels).toHaveLength(1))
    expect(document.querySelector('[data-canvas-group-frame="g1"]')?.getAttribute('data-canvas-group-member-count')).toBe('1')
    expect(document.querySelector('[data-canvas-groups-menu="true"]')).toBeTruthy()
    act(() => useTaskGroupStore.setState({ membership: {} }))
    await waitFor(() => expect(document.querySelector('[data-canvas-group-frame="g1"]')?.getAttribute('data-canvas-group-member-count')).toBe('0'))
  })

  it('keeps closed panels closed across new members and refresh, while explicit Show reopens them', async () => {
    useCanvasStore.getState().showGroup('g1', ['t1'])
    render(<CanvasGroups />)
    await waitFor(() => expect(useCanvasStore.getState().panels).toHaveLength(1))
    act(() => useCanvasStore.getState().removePanel(useCanvasStore.getState().panels[0].id))
    act(() => useTaskGroupStore.setState({ membership: { t1: 'g1', t2: 'g1' } }))
    await waitFor(() => expect(useCanvasStore.getState().panels.map(p => p.refId)).toEqual(['t2']))
    act(() => useTaskGroupStore.getState().showOnCanvas('g1'))
    await waitFor(() => expect(useCanvasStore.getState().panels).toHaveLength(2))
    act(() => useCanvasStore.getState().removePanel(useCanvasStore.getState().panels.find(p => p.refId === 't1')!.id))
    act(() => useTaskGroupStore.getState().showOnCanvas('g1'))
    await waitFor(() => expect(useCanvasStore.getState().panels).toHaveLength(2))
    expect(useTaskGroupStore.getState().membership).toEqual({ t1: 'g1', t2: 'g1' })
  })

  it('waits for saved layout, opens a requested Factory after async data, and connects Groups opened through Tasks', async () => {
    window.electronAPI.responsibilities = { snapshot: vi.fn(async () => ({ steps: [{ responsibilityId: 'r1', taskId: 't1', phase: 'coordinate' }, { responsibilityId: 'r1', taskId: 't2', phase: 'work', predecessorTaskIds: ['t1'] }] })), onChanged: vi.fn(() => vi.fn()) } as never
    useTaskGroupStore.setState({ membership: { t1: 'g1', t2: 'g1' }, executions: { r1: 'g1' } })
    useCanvasStore.setState({ isLoaded: false })
    useUIStore.getState().showResponsibilityOnCanvas('r1')
    render(<><CanvasGroups /><FactoryCanvas /></>)
    await act(async () => {})
    expect(useCanvasStore.getState().panels).toHaveLength(0)
    act(() => useCanvasStore.setState({ isLoaded: true }))
    await waitFor(() => expect(useCanvasStore.getState().panels).toHaveLength(2))
    await waitFor(() => expect(useCanvasStore.getState().edges).toHaveLength(1))
    act(() => useCanvasStore.getState().removePanel(useCanvasStore.getState().panels[0].id))
    await act(async () => {})
    expect(useCanvasStore.getState().panels).toHaveLength(1)
    act(() => useUIStore.getState().showResponsibilityOnCanvas('r1'))
    await waitFor(() => expect(useCanvasStore.getState().panels).toHaveLength(2))
    act(() => { useUIStore.setState({ canvasResponsibilityId: null }); useCanvasStore.getState().removeEdge(useCanvasStore.getState().edges[0].id) })
    await waitFor(() => expect(useCanvasStore.getState().edges).toHaveLength(1))
  })
})
