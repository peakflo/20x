import type { ResponsibilityExecution, ResponsibilityExecutionState } from '@shared/responsibilities'
import { executionIdForGroupLink } from '@shared/task-groups'

const priority: Record<ResponsibilityExecutionState, number> = {
  interrupted: 6,
  needs_attention: 5,
  ready_for_review: 4,
  running: 3,
  pending: 2,
  done: 1,
  cancelled: 0,
}

export const executionStateLabel: Record<ResponsibilityExecutionState, string> = {
  pending: 'Starting',
  running: 'Running',
  needs_attention: 'Needs attention',
  ready_for_review: 'Ready for review',
  done: 'Done',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
}

export function executionStateForGroup(
  groupId: string,
  links: Record<string, string | null>,
  executions: Record<string, ResponsibilityExecution>,
): ResponsibilityExecutionState | undefined {
  return Object.entries(links)
    .filter(([, linkedGroupId]) => linkedGroupId === groupId)
    .flatMap(([link]) => executions[executionIdForGroupLink(link)] ? [executions[executionIdForGroupLink(link)].state] : [])
    .sort((a, b) => priority[b] - priority[a])[0]
}

export const isFinishedExecutionState = (state?: ResponsibilityExecutionState): boolean => state === 'done' || state === 'cancelled'
