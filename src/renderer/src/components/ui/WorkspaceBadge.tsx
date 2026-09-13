import { Badge } from './Badge'
import { useUIStore } from '@/stores/ui-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import type { TaskGroup } from '@shared/task-groups'

export function taskWorkspaceId(
  taskId: string,
  taskProjects: Record<string, string>,
  groups: TaskGroup[],
  membership: Record<string, string>
): string | null {
  if (taskProjects[taskId]) return taskProjects[taskId]
  const groupId = membership[taskId]
  return groups.find(group => group.id === groupId)?.projectId ?? null
}

export function useTaskWorkspaceId(taskId?: string): string | null {
  const direct = useUIStore(state => taskId ? state.mastermindTaskProjects?.[taskId] : undefined)
  const groupId = useTaskGroupStore(state => taskId ? state.membership[taskId] : undefined)
  const grouped = useTaskGroupStore(state => groupId ? state.groups.find(group => group.id === groupId)?.projectId : undefined)
  return direct ?? grouped ?? null
}

export function WorkspaceBadge({ projectId, className = '' }: { projectId: string | null | undefined; className?: string }) {
  const name = useUIStore(state => projectId ? state.mastermindProjects?.find(project => project.id === projectId)?.name : undefined)
  return <Badge className={className} title={projectId ? `Workspace: ${name ?? 'Unknown workspace'}` : 'No workspace'}>{name ?? (projectId ? 'Unknown workspace' : 'No workspace')}</Badge>
}
