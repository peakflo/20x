import { TaskStatus } from './constants'

export type SubtaskFilter = 'all' | 'working' | 'review' | 'completed' | 'other'

export const SUBTASK_FILTERS: { id: SubtaskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'In progress' },
  { id: 'review', label: 'Ready for review' },
  { id: 'completed', label: 'Completed' },
  { id: 'other', label: 'Other' }
]

export function subtaskFilterForStatus(status: string): Exclude<SubtaskFilter, 'all'> {
  if (status === TaskStatus.AgentWorking) return 'working'
  if (status === TaskStatus.ReadyForReview) return 'review'
  if (status === TaskStatus.Completed) return 'completed'
  return 'other'
}

export function filterSubtasks<T extends { title: string; status: string }>(subtasks: T[], filter: SubtaskFilter, query: string): T[] {
  const search = query.trim().toLocaleLowerCase()
  return subtasks.filter((subtask) =>
    (filter === 'all' || subtaskFilterForStatus(subtask.status) === filter)
    && (!search || subtask.title.toLocaleLowerCase().includes(search))
  )
}
