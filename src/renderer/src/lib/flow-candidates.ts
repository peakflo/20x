import type { WorkfloTask } from '@/types'

/** Find repeated completed tasks with the same assigned agent. */
export function repeatedTasks(task: WorkfloTask, all: WorkfloTask[]): WorkfloTask[] {
  const key = (title: string) => title.toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ').trim()
  return all.filter((item) => key(item.title) === key(task.title) &&
    item.agent_id === task.agent_id && item.status === 'completed')
}
