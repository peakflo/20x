import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GroupControls } from './TaskGroups'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'

const task = { id: 'task-1', title: 'Existing task', status: TaskStatus.NotStarted } as never

describe('GroupControls', () => {
  beforeEach(() => {
    const manage = vi.fn(async (action) => ({ success: true, groupId: action.action === 'create' ? 'group-1' : undefined }))
    Object.assign(window.electronAPI, { taskGroups: { snapshot: vi.fn(async () => ({ groups: [{ id: 'group-1', name: 'Group', description: '', projectId: null, createdAt: '' }], membership: {}, executions: {} })), manage, onChanged: vi.fn(() => vi.fn()) } })
    useTaskStore.setState({ tasks: [task] })
    useTaskGroupStore.setState({ groups: [{ id: 'group-1', name: 'Group', description: '', projectId: null, createdAt: '' }], membership: {}, executions: {}, view: 'groups', canvasGroupId: null, error: null })
    useUIStore.setState({ activeModal: null })
  })
  afterEach(cleanup)

  it('keeps group context for task creation and manages selected tasks', async () => {
    render(<GroupControls groupId="group-1" />)
    fireEvent.click(screen.getByTitle('Manage group'))
    fireEvent.click(screen.getByLabelText('Select Existing task'))
    fireEvent.click(screen.getByText('Add / move here'))
    await waitFor(() => expect(window.electronAPI.taskGroups.manage).toHaveBeenCalledWith({ action: 'assign', group_id: 'group-1', task_ids: ['task-1'] }))
    fireEvent.click(screen.getByText('New task in group'))
    expect(useTaskGroupStore.getState().creationGroupId).toBe('group-1')
    expect(useUIStore.getState().activeModal).toBe('create')
    fireEvent.click(screen.getByTitle('Manage group'))
    fireEvent.click(screen.getByText('Delete group only'))
    await waitFor(() => expect(window.electronAPI.taskGroups.manage).toHaveBeenCalledWith({ action: 'delete', group_id: 'group-1' }))
  })
})
