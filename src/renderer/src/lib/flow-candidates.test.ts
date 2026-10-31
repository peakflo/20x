import { describe, expect, it } from 'vitest'
import { repeatedTasks } from './flow-candidates'
import type { WorkfloTask } from '@/types'

describe('repeatedTasks', () => {
  it('uses completed tasks from one agent and normalizes dates and numbers', () => {
    const task = { title: 'Review invoice 2026-10-25 #12', agent_id: 'agent-a' } as WorkfloTask
    const rows = [
      { title: 'Review invoice 2026-10-23 #10', agent_id: 'agent-a', status: 'completed' },
      { title: 'Review invoice 2026-10-24 #11', agent_id: 'agent-a', status: 'completed' },
      { title: 'Review invoice 2026-10-25 #12', agent_id: 'agent-b', status: 'completed' },
      { title: 'Review invoice 2026-10-26 #13', agent_id: 'agent-a', status: 'agent_working' }
    ] as WorkfloTask[]
    expect(repeatedTasks(task, rows)).toHaveLength(2)
  })
})
