import { describe, expect, it, vi } from 'vitest'
import { TASK_WRITE_HEADERS } from '../shared/task-write-contract'
import type { EnterpriseAuth } from './enterprise-auth'
import { WorkfloApiClient, type WorkfloTask } from './workflo-api-client'

describe('WorkfloApiClient task writes', () => {
  it('uses the strict collection-command route when creating a task', async () => {
    const task = { id: 'remote-task' } as WorkfloTask
    const apiRequest = vi.fn().mockResolvedValue({ task })
    const client = new WorkfloApiClient({ apiRequest } as unknown as EnterpriseAuth)
    const data = {
      clientRequestId: '20x:request-1',
      title: 'Fix task upload',
      description: 'Use the registered Workflo route'
    }

    await expect(client.createTask(data)).resolves.toBe(task)
    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/tasks/', data, TASK_WRITE_HEADERS)
  })
})
