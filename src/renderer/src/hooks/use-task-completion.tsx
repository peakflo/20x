import { getTaskCompletionAction } from '@shared/task-completion'
import { useCallback } from 'react'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

export interface UseTaskCompletionOptions {
  onToast?: (message: string, isError?: boolean) => void
}
export interface CompleteTaskRequestOptions {
  onCompleted?: (task: WorkfloTask) => void
}

/** Sourced completion is confirmed externally; source-less 20x tasks stay local. */
export function useTaskCompletion({ onToast }: UseTaskCompletionOptions = {}) {
  const executeAction = useTaskSourceStore(s => s.executeAction)
  const requestComplete = useCallback(async (taskId: string, options?: CompleteTaskRequestOptions) => {
    const task = useTaskStore.getState().tasks.find(t => t.id === taskId)
    if (!task) return
    try {
      if (!task.source_id) {
        await useTaskStore.getState().updateTask(task.id, { status: TaskStatus.Completed })
        const completedTask = { ...task, status: TaskStatus.Completed }
        options?.onCompleted?.(completedTask)
        onToast?.(`"${task.title}" completed`)
        return
      }
      const action = getTaskCompletionAction(task.output_fields)
      const result = await executeAction(action, task.id, task.source_id)
      if (!result.success) throw new Error(result.error || 'The server did not confirm completion.')
      await useTaskStore.getState().fetchTasks()
      options?.onCompleted?.(task)
      onToast?.(`"${task.title}" completed`)
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
    }
  }, [executeAction, onToast])
  return { requestComplete }
}
