export interface TaskGroup {
  id: string
  name: string
  description: string
  projectId: string | null
  createdAt: string
}

export interface TaskGroupsSnapshot {
  groups: TaskGroup[]
  /** Effective membership, including inherited subtask and recurring-instance membership. */
  membership: Record<string, string>
  executions: Record<string, string | null>
}

export interface TaskGroupAction {
  action: 'create' | 'update' | 'assign' | 'delete' | 'delete_with_tasks' | 'assign_execution'
  group_id?: string | null
  name?: string
  description?: string
  project_id?: string
  task_ids?: string[]
  responsibility_id?: string
}

export interface TaskGroupResult {
  success: boolean
  cancelled?: boolean
  error?: string
  groupId?: string
  deletedTaskIds?: string[]
  remainingTaskIds?: string[]
}

export interface TaskGroupsApi {
  snapshot(): Promise<TaskGroupsSnapshot>
  manage(action: TaskGroupAction): Promise<TaskGroupResult>
  onChanged(callback: () => void): () => void
}
