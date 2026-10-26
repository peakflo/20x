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

describe('WorkfloApiClient skill catalog', () => {
  it('asks for system skills and accepts a wrapped catalog', async () => {
    const systemSkill = {
      id: 'system-skill',
      name: 'self-improving-workflows',
      scope: 'system',
      autoAttach: true
    }
    const apiRequest = vi.fn().mockResolvedValue({ skills: [systemSkill] })
    const client = new WorkfloApiClient({ apiRequest } as unknown as EnterpriseAuth)

    await expect(client.listSkills()).resolves.toEqual([systemSkill])
    expect(apiRequest).toHaveBeenCalledWith('GET', '/api/skills?includeSystem=true')
  })

  it('accepts a tenant-only array from an older server', async () => {
    const tenantSkill = { id: 'tenant-skill', name: 'Tenant skill' }
    const apiRequest = vi.fn().mockResolvedValue([tenantSkill])
    const client = new WorkfloApiClient({ apiRequest } as unknown as EnterpriseAuth)

    await expect(client.listSkills()).resolves.toEqual([tenantSkill])
    expect(apiRequest).toHaveBeenCalledWith('GET', '/api/skills?includeSystem=true')
  })
})
